/** Real TLS/Git on owned loopback only. Test routing is deliberately outside production config. */
import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpsRequest } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { pinnedHttpsGet } from '../../packages/plugin-sdk/src/egress.ts';
it('real owned TLS server verifies hostname/pin options, rejects redirects and Git refuses following them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-owned-tls-')),
    key = join(root, 'key.pem'),
    cert = join(root, 'cert.pem');
  // Ephemeral synthetic certificate only; never a real integration credential or installed CA.
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=example.org',
      '-addext',
      'subjectAltName=DNS:example.org',
    ],
    { stdio: 'ignore' },
  );
  let hits = 0;
  let redirect = false;
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (_request, response) => {
      hits++;
      if (redirect)
        response
          .writeHead(302, { location: 'https://example.org/redirected' })
          .end();
      else response.end('owned TLS fixture');
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture');
    const client = pinnedHttpsGet({
      hosts: ['example.org'],
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: (url, options, callback) => {
        expect(options.rejectUnauthorized).toBe(true);
        expect(options.servername).toBe('example.org');
        options.lookup!(
          url.hostname,
          { family: 4, all: false },
          (error, address, family) => {
            expect(error).toBe(null);
            expect(address).toBe('93.184.216.34');
            expect(family).toBe(4);
          },
        );
        return httpsRequest(
          url,
          {
            ...options,
            port: address.port,
            ca: readFileSync(cert),
            lookup: (_hostname, _options, callback) =>
              callback(null, '127.0.0.1', 4),
          },
          callback,
        );
      },
    });
    expect(await (await client('https://example.org/')).text()).toBe(
      'owned TLS fixture',
    );
    redirect = true;
    await expect(client('https://example.org/')).rejects.toThrow(
      'EGRESS_REDIRECT_DENIED',
    );
    expect(hits).toBe(2);
    const result = await new Promise<{ code: number | null; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          'git',
          [
            '-c',
            'http.proxy=',
            '-c',
            'http.sslVerify=true',
            '-c',
            'http.sslCAInfo=' + cert,
            '-c',
            'http.followRedirects=false',
            '-c',
            'http.curloptResolve=',
            '-c',
            `http.curloptResolve=example.org:${address.port}:127.0.0.1`,
            'ls-remote',
            `https://example.org:${address.port}/repo`,
          ],
          {
            cwd: root,
            env: {
              PATH: process.env['PATH'],
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_SYSTEM: '/dev/null',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_TERMINAL_PROMPT: '0',
            },
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        );
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stderr });
        });
      },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('302');
    expect(hits).toBe(3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
