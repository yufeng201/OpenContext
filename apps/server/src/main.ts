import { resolve } from 'node:path';
import { createApplication } from './app.ts';

const demo = process.argv.includes('--demo');
const ownerToken =
  process.env['OPENCONTEXT_OWNER_TOKEN'] ??
  (demo ? 'opencontext-demo-owner-loopback-only-2026' : '');
if (ownerToken.length < 32)
  throw new Error(
    'Provide OPENCONTEXT_OWNER_TOKEN (32+ chars) through a private environment, or use pnpm dev for local synthetic demo.',
  );
const dataRoot = resolve(process.env['OPENCONTEXT_DATA_ROOT'] ?? 'runtime');
const localRoot = process.env['OPENCONTEXT_TEST_REPO_ROOT'];
const application = createApplication({
  dataRoot,
  ownerToken,
  ...(localRoot ? { allowedLocalRepoRoot: resolve(localRoot) } : {}),
});
const port = Number(process.env['PORT'] ?? 4310);
await application.app.listen({ host: '127.0.0.1', port });
console.log('OpenContext local development slice: http://127.0.0.1:' + port);
if (demo)
  console.log(
    'Synthetic local demo token: opencontext-demo-owner-loopback-only-2026. Not for shared or production deployment.',
  );
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void application.app.close();
  });
