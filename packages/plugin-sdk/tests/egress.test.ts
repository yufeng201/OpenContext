import { describe, expect, it } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import {
  publicAddress,
  publicUrl,
  resolvePublicTarget,
  pinnedHttpsGet,
  gitPin,
} from '../src/egress.ts';
const public4 = { address: '93.184.216.34', family: 4 };
describe('production egress policy; synthetic DNS only', () => {
  it.each([
    'http://example.org/x',
    'https://localhost/x',
    'https://localtest.local/x',
    'https://service.internal/x',
    'https://metadata.google.internal/x',
    'https://example.org.:443/x',
    'https://user:secret@example.org/x',
    'https://example.org:8443/x',
    'https://127.1/x',
    'https://2130706433/x',
    'https://0x7f000001/x',
    'https://0177.0.0.1/x',
    'https://%31%32%37.0.0.1/x',
    'https://[::1]/x',
    'https://[::ffff:7f00:1]/x',
    'https://[fe80::1%25eth0]/x',
  ])('denies %s before resolving or opening sockets', async (value) => {
    let calls = 0;
    await expect(
      resolvePublicTarget(value, {
        resolve: async () => {
          calls++;
          return [public4];
        },
      }),
    ).rejects.toThrow('EGRESS_DENIED');
    expect(calls).toBe(0);
  });
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.100.100.200',
    '127.0.0.1',
    '169.254.169.254',
    '172.31.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:169.254.169.254',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '64:ff9b::a00:1',
  ])(
    'denies DNS answer %s including metadata and transition ranges',
    async (address) => {
      const family = address.includes(':') ? 6 : 4;
      expect(publicAddress({ address, family })).toBe(false);
      await expect(
        resolvePublicTarget('https://example.org/repo', {
          resolve: async () => [public4, { address, family }],
        }),
      ).rejects.toThrow('EGRESS_DENIED');
    },
  );
  it('rejects empty, contradictory and huge answers, rechecks changing DNS and exact vendor allowlist', async () => {
    for (const answers of [
      [],
      [{ address: '93.184.216.34', family: 6 }],
      Array.from({ length: 33 }, () => public4),
    ])
      await expect(
        resolvePublicTarget('https://example.org/', {
          resolve: async () => answers,
        }),
      ).rejects.toThrow('EGRESS_DENIED');
    let count = 0;
    const resolve = async () =>
      ++count === 1 ? [public4] : [{ address: '10.0.0.1', family: 4 }];
    const first = await resolvePublicTarget('https://example.org/', {
      resolve,
    });
    expect(gitPin(first.url, first.addresses[0]!)).toContain(
      'http.curloptResolve=example.org:443:93.184.216.34',
    );
    await expect(
      resolvePublicTarget('https://example.org/', { resolve }),
    ).rejects.toThrow('EGRESS_DENIED');
    expect(
      publicUrl('https://open.feishu.cn/x', ['open.feishu.cn']).hostname,
    ).toBe('open.feishu.cn');
    expect(() =>
      publicUrl('https://open.feishu.cn.evil.org/x', ['open.feishu.cn']),
    ).toThrow('EGRESS_DENIED');
    const ipv6 = { address: '2606:4700:4700::1111', family: 6 };
    expect(publicAddress(ipv6)).toBe(true);
    expect(gitPin(new URL('https://example.org'), ipv6)).toContain(
      'http.curloptResolve=example.org:443:[2606:4700:4700::1111]',
    );
  });
  it('bounds hanging DNS and redacts resolver failures', async () => {
    await expect(
      resolvePublicTarget('https://example.org/', {
        timeoutMs: 20,
        resolve: () => new Promise(() => {}),
      }),
    ).rejects.toThrow('EGRESS_TIMEOUT');
    await expect(
      resolvePublicTarget('https://example.org/', {
        resolve: async () => {
          throw new Error('PRIVATE_DNS_DETAIL');
        },
      }),
    ).rejects.toThrow(/^EGRESS_RESOLUTION_FAILED$/);
  });
  it('actual local fixture refuses redirect/oversize/timeout with no second request, while default options pin TLS', async () => {
    let hits = 0;
    let path = '/ok';
    const server = createServer((_request, response) => {
      hits++;
      if (path === '/redirect')
        response.writeHead(302, { location: 'http://169.254.169.254/' }).end();
      else if (path === '/large') response.end('x'.repeat(129));
      else if (path === '/declared')
        response.writeHead(200, { 'content-length': '129' }).end();
      else if (path === '/hang') return;
      else response.end('synthetic');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture');
    const client = pinnedHttpsGet({
      hosts: ['example.org'],
      resolve: async () => [public4],
      timeoutMs: 80,
      maxBytes: 128,
      transport: (url, options, callback) => {
        expect(url.hostname).toBe('example.org');
        expect(options.rejectUnauthorized).toBe(true);
        expect(options.servername).toBe('example.org');
        expect(options.agent).toBe(false);
        expect(options.family).toBe(4);
        // Fixture adapter routes only to our own HTTP service; no real public or private targets.
        return httpRequest(
          new URL('http://127.0.0.1:' + address.port + path),
          { signal: options.signal },
          callback,
        );
      },
    });
    try {
      expect(await (await client('https://example.org/')).text()).toBe(
        'synthetic',
      );
      path = '/redirect';
      await expect(client('https://example.org/')).rejects.toThrow(
        'EGRESS_REDIRECT_DENIED',
      );
      expect(hits).toBe(2);
      for (path of ['/large', '/declared'])
        await expect(client('https://example.org/')).rejects.toThrow(
          'RESPONSE_TOO_LARGE',
        );
      path = '/hang';
      await expect(client('https://example.org/')).rejects.toThrow(
        'EGRESS_TIMEOUT',
      );
      expect(hits).toBe(5);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
