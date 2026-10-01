/** Explicit local demonstration of simulated official responses, not a live connection. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createApplication } from '../apps/server/src/app.ts';
import { feishuApiFixture } from '../tests/fixtures/feishu-api.ts';

const dataRoot = mkdtempSync(resolve(tmpdir(), 'opencontext-feishu-fixture-'));
const application = createApplication({
  dataRoot,
  ownerToken: 'synthetic-feishu-demo-loopback-only-2026',
  feishu: feishuApiFixture(),
  ...(process.env['OPENCONTEXT_TEST_REPO_ROOT']
    ? {
        allowedLocalRepoRoot: resolve(
          process.env['OPENCONTEXT_TEST_REPO_ROOT'],
        ),
      }
    : {}),
});
const address = await application.app.listen({
  host: '127.0.0.1',
  port: Number(process.env['PORT'] ?? '4534'),
});
console.log(
  'SIMULATED Feishu API only; no real group or credential: ' + address,
);
console.log('Synthetic login token: synthetic-feishu-demo-loopback-only-2026');
console.log('Temporary fixture data: ' + dataRoot);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void application.app.close();
  });
