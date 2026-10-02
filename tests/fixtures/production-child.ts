/** Synthetic only: never registered by the production composition root. */
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../../apps/server/src/app.ts';
import { serve } from '../../apps/server/src/runtime.ts';
import { ownerToken, runtimeConfig } from '../../apps/server/src/deployment.ts';
import { codexSessionDefinition } from '../../plugins/session-connector/src/index.ts';
import { sessionCandidatesDefinition } from '../../plugins/session-candidates/src/index.ts';
import { StaticRegistry } from '../../packages/plugin-host/src/index.ts';
const block = process.env['FIXTURE_BLOCK']!;
const connector = {
  ...codexSessionDefinition,
  artifactPaths: [...codexSessionDefinition.artifactPaths, import.meta.url],
  async invoke(...args: Parameters<typeof codexSessionDefinition.invoke>) {
    writeFileSync(block + '.entered', 'synthetic');
    while (existsSync(block))
      await delay(20, undefined, { signal: args[1].signal });
    return codexSessionDefinition.invoke(...args);
  },
};
const application = createApplication({
  dataRoot: process.env['OPENCONTEXT_DATA_ROOT']!,
  ownerToken: ownerToken(process.env),
  registry: new StaticRegistry([connector, sessionCandidatesDefinition]),
});
if (process.env['FIXTURE_CLOSE_FAIL'] === '1')
  application.app.addHook('onClose', async () => {
    throw new Error('synthetic-private-close-diagnostic');
  });
application.app.get('/fixture/drain', async () => {
  console.log('fixture_request_entered');
  await delay(Number(process.env['FIXTURE_REQUEST_MS'] ?? '150'));
  return { drained: true };
});
console.log(
  'OpenContext local development slice: ' +
    (await serve(application.app, runtimeConfig(process.env))),
);
