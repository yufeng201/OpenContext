/** Reviewed server-owned transport. Client plugin config cannot replace DNS or sockets. */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { IncomingMessage, ClientRequest } from 'node:http';
export type Address = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<Address[]>;
const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  denied.addSubnet(address, prefix, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  denied.addSubnet(address, prefix, 'ipv6');
export function publicAddress(value: Address): boolean {
  const family = isIP(value.address);
  if (family !== value.family) return false;
  return family === 4
    ? !denied.check(value.address, 'ipv4')
    : family === 6 &&
        global6.check(value.address, 'ipv6') &&
        !denied.check(value.address, 'ipv6');
}
export function publicUrl(input: string | URL, hosts?: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('EGRESS_DENIED');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    isIP(host) ||
    host.endsWith('.') ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host) ||
    [
      'localhost',
      'local',
      'internal',
      'test',
      'invalid',
      'example',
      'home',
      'lan',
    ].some((s) => host === s || host.endsWith('.' + s)) ||
    (hosts && !hosts.includes(host))
  )
    throw new Error('EGRESS_DENIED');
  return url;
}
export async function resolvePublicTarget(
  input: string | URL,
  options: {
    hosts?: readonly string[];
    resolve?: Resolver;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
) {
  const url = publicUrl(input, options.hosts);
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(options.timeoutMs ?? 2000),
  ]);
  if (signal.aborted) throw new Error('EGRESS_TIMEOUT');
  const resolver =
    options.resolve ?? (async (host: string) => lookup(host, { all: true }));
  let addresses: Address[];
  let abort: (() => void) | undefined;
  try {
    addresses = await Promise.race([
      resolver(url.hostname),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('EGRESS_TIMEOUT'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } catch (error) {
    if (signal.aborted) throw new Error('EGRESS_TIMEOUT', { cause: error });
    throw new Error('EGRESS_RESOLUTION_FAILED', { cause: error });
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
  if (
    !addresses.length ||
    addresses.length > 32 ||
    addresses.some((a) => !publicAddress(a))
  )
    throw new Error('EGRESS_DENIED');
  return { url, addresses };
}
export function gitPin(url: URL, address: Address): string[] {
  // Non-expiring exact HOST:PORT pin; redirects are independently disabled.
  return [
    '-c',
    'http.curloptResolve=',
    '-c',
    `http.curloptResolve=${url.hostname}:443:${address.family === 6 ? '[' + address.address + ']' : address.address}`,
  ];
}
type Transport = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;
/** Dependency injection is for synthetic tests only, never an HTTP/connector config option. */
export function pinnedHttpsGet(options: {
  hosts: readonly string[];
  resolve?: Resolver;
  transport?: Transport;
  timeoutMs?: number;
  maxBytes?: number;
}) {
  return async (
    input: string | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    if (init.method && init.method !== 'GET') throw new Error('EGRESS_DENIED');
    const signal = AbortSignal.any([
      ...(init.signal ? [init.signal] : []),
      AbortSignal.timeout(options.timeoutMs ?? 10_000),
    ]);
    const target = await resolvePublicTarget(input, {
      hosts: options.hosts,
      ...(options.resolve ? { resolve: options.resolve } : {}),
      signal,
    });
    const pin = target.addresses[0]!;
    const requestHeaders: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      requestHeaders[key] = value;
    });
    return new Promise<Response>((resolve, reject) => {
      const request = (options.transport ?? httpsRequest)(
        target.url,
        {
          method: 'GET',
          agent: false,
          rejectUnauthorized: true,
          servername: target.url.hostname,
          headers: { ...requestHeaders, 'accept-encoding': 'identity' },
          signal,
          family: pin.family,
          maxHeaderSize: 16384,
          lookup: (_host, _options, callback) =>
            callback(null, pin.address, pin.family),
        },
        (response) => {
          const maximum = options.maxBytes ?? 2_097_152;
          const code = response.statusCode ?? 500;
          if (code < 200 || code > 599) {
            response.destroy();
            reject(new Error('INVALID_RESPONSE'));
            return;
          }
          if (code >= 300 && code < 400) {
            response.destroy();
            reject(new Error('EGRESS_REDIRECT_DENIED'));
            return;
          }
          if (
            (response.headers['content-encoding'] &&
              response.headers['content-encoding'] !== 'identity') ||
            Number(response.headers['content-length']) > maximum
          ) {
            response.destroy();
            reject(new Error('RESPONSE_TOO_LARGE'));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maximum) {
              response.destroy();
              reject(new Error('RESPONSE_TOO_LARGE'));
            } else chunks.push(chunk);
          });
          response.on('error', () =>
            reject(
              new Error(signal.aborted ? 'EGRESS_TIMEOUT' : 'NETWORK_ERROR'),
            ),
          );
          response.on('end', () => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers))
              if (value !== undefined)
                headers.set(
                  key,
                  Array.isArray(value) ? value.join(', ') : value,
                );
            resolve(
              new Response(
                code === 204 || code === 205 || code === 304
                  ? null
                  : Buffer.concat(chunks),
                { status: code, headers },
              ),
            );
          });
        },
      );
      request.on('error', () =>
        reject(new Error(signal.aborted ? 'EGRESS_TIMEOUT' : 'NETWORK_ERROR')),
      );
      request.end();
    });
  };
}
