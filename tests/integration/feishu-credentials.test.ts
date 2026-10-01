import { expect, it } from 'vitest';
import { feishuCredentials } from '../../apps/server/src/feishu-credentials.ts';

it('only resolves an explicitly configured secret alias for its exact realm and group', async () => {
  const token = 'synthetic-not-a-feishu-credential';
  const resolve = feishuCredentials({
    OPENCONTEXT_FEISHU_SECRET_REF: 'secret:feishu/synthetic',
    OPENCONTEXT_FEISHU_REALM: 'feishu',
    OPENCONTEXT_FEISHU_CHAT_ID: 'oc_synthetic_group',
    OPENCONTEXT_FEISHU_TOKEN: token,
    UNRELATED_SECRET: 'must-not-be-used',
  });
  const scope = { realm: 'feishu' as const, chatId: 'oc_synthetic_group' };
  expect(await resolve('secret:feishu/synthetic', scope)).toBe(token);
  expect(await resolve('secret:feishu/missing', scope)).toBeUndefined();
  await expect(
    resolve('secret:feishu/synthetic', { ...scope, realm: 'lark' }),
  ).rejects.toThrow('SECRET_SCOPE_DENIED');
  await expect(
    resolve('secret:feishu/synthetic', { ...scope, chatId: 'oc_other_group' }),
  ).rejects.toThrow('SECRET_SCOPE_DENIED');
  expect(
    await feishuCredentials({})('secret:feishu/synthetic', scope),
  ).toBeUndefined();
});
