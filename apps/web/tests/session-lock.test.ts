import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('persists only a disconnect marker across reloads and removes it on explicit login', async () => {
  const data = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
  vi.resetModules();
  const first = await import('../src/lib/session-lock');
  first.setLocallyDisconnected(true);
  expect([...data]).toEqual([['opencontext.disconnected', '1']]);
  vi.resetModules();
  const reloaded = await import('../src/lib/session-lock');
  expect(reloaded.isLocallyDisconnected()).toBe(true);
  reloaded.setLocallyDisconnected(false);
  expect(reloaded.isLocallyDisconnected()).toBe(false);
  expect(data.size).toBe(0);
});

it('keeps an in-memory disconnect if browser storage is unavailable', async () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  });
  vi.resetModules();
  const session = await import('../src/lib/session-lock');
  session.setLocallyDisconnected(true);
  expect(session.isLocallyDisconnected()).toBe(true);
  session.setLocallyDisconnected(false);
  expect(session.isLocallyDisconnected()).toBe(false);
});
