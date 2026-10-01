import { resolve } from 'node:path';
import { createApplication } from './app.ts';
import { feishuCredentials } from './feishu-credentials.ts';

const demo = process.argv.includes('--demo');
if (demo && process.env['OPENCONTEXT_FEISHU_TOKEN'] !== undefined)
  throw new Error(
    'DEMO_FEISHU_CREDENTIAL_CONFLICT: use a private owner and pnpm start for authorized Feishu access.',
  );
if (demo && process.env['OPENCONTEXT_OWNER_TOKEN'] !== undefined)
  throw new Error(
    'DEMO_OWNER_TOKEN_CONFLICT: use pnpm start for private data, or unset OPENCONTEXT_OWNER_TOKEN for a separate synthetic demo.',
  );
const ownerToken = demo
  ? 'opencontext-demo-owner-loopback-only-2026'
  : (process.env['OPENCONTEXT_OWNER_TOKEN'] ?? '');
if (ownerToken.length < 32)
  throw new Error(
    'Provide OPENCONTEXT_OWNER_TOKEN (32–256 chars) through a private environment, or use pnpm dev for local synthetic demo.',
  );
const dataRoot = resolve(
  process.env['OPENCONTEXT_DATA_ROOT'] ?? (demo ? 'runtime-demo' : 'runtime'),
);
const localRoot = process.env['OPENCONTEXT_TEST_REPO_ROOT'];
const application = createApplication({
  dataRoot,
  dataMode: demo ? 'demo' : 'private',
  ownerToken,
  feishu: { resolveCredential: feishuCredentials(process.env) },
  ...(localRoot ? { allowedLocalRepoRoot: resolve(localRoot) } : {}),
});
const port = Number(process.env['PORT'] ?? 4310);
let address: string;
try {
  address = await application.app.listen({ host: '127.0.0.1', port });
} catch (error) {
  await application.app.close();
  throw error;
}
console.log('OpenContext local development slice: ' + address);
if (demo)
  console.log(
    'Synthetic local demo token: opencontext-demo-owner-loopback-only-2026. Not for shared or production deployment.',
  );
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void application.app.close();
  });
