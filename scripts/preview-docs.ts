import { readStaticAsset } from '../apps/server/src/static.ts';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('apps/docs/dist');
if (!existsSync(resolve(root, 'index.html')))
  throw new Error('BUILD_DOCS_FIRST');
const server = createServer((request, response) => {
  let path: string;
  try {
    path = decodeURIComponent(
      new URL(request.url ?? '/', 'http://localhost').pathname,
    );
  } catch {
    response.writeHead(400).end();
    return;
  }
  const file = path === '/' ? 'index.html' : path.slice(1);
  if (
    !/^[a-z0-9-]+\.(html|css|json|txt)$/.test(file) ||
    !existsSync(resolve(root, file))
  ) {
    response.writeHead(404).end('Not found');
    return;
  }
  let body: Buffer;
  try {
    body = readStaticAsset(root, resolve(root, file));
  } catch {
    response.writeHead(404).end('Not found');
    return;
  }
  response.setHeader(
    'Content-Type',
    file.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : file.endsWith('.css')
        ? 'text/css'
        : file.endsWith('.json')
          ? 'application/json'
          : 'text/plain; charset=utf-8',
  );
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(body);
});
server.listen(Number(process.env['DOCS_PORT'] ?? '4400'), '127.0.0.1', () =>
  console.log(
    'Local docs preview: http://127.0.0.1:' +
      String(process.env['DOCS_PORT'] ?? '4400'),
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => server.close());
