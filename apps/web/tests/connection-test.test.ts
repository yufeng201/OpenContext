import { expect, it } from 'vitest';
import { connectionResultText } from '../src/lib/connection-test';

it('never presents a simulated reachable check as a live Feishu connection', () => {
  const result = connectionResultText({
    status: 'reachable',
    evidence: 'simulated',
    code: 'FEISHU_CONNECTION_OK',
  });
  expect(result.evidence).toBe('模拟接口验证，未连接真实飞书');
  expect(result.explanation).toContain('不代表完整历史');
});

it('limits a live reachable result to the requested group history interface', () => {
  const result = connectionResultText({
    status: 'reachable',
    evidence: 'live',
    code: 'FEISHU_CONNECTION_OK',
  });
  expect(result.evidence).toBe('指定群历史接口可读');
  expect(result.explanation).toContain('全部权限');
});

it.each(['SECRET_NOT_CONFIGURED', 'SECRET_SCOPE_DENIED'])(
  'directs %s to server-side secretRef administration',
  (code) => {
    const result = connectionResultText({
      status: 'blocked',
      evidence: 'simulated',
      code,
    });
    expect(result.status).toBe('本次检查受阻');
    expect(result.explanation).toContain('管理员');
    expect(result.explanation).toContain('secretRef');
  },
);

it('keeps unfamiliar safe failure codes actionable without invented details', () => {
  const result = connectionResultText({
    status: 'error',
    evidence: 'live',
    code: 'FUTURE_PROVIDER_ERROR',
  });
  expect(result.evidence).toBe('真实接口诊断未通过');
  expect(result.explanation).toContain('诊断代码');
});
