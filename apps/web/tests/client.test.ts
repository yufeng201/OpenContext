import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  handleAccessDenied,
  resetSessionRequests,
} from '../src/api/client';

afterEach(() => {
  resetSessionRequests();
  vi.unstubAllGlobals();
});

describe('Web request boundary', () => {
  it('does not send an empty JSON Content-Type for an action with no body', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    await api('/projects/fixture/bindings/fixture/sync', { method: 'POST' });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'same-origin',
      headers: {},
    });
  });

  it('notifies permission loss and does not expose the server error body', async () => {
    const denied = vi.fn();
    const stop = handleAccessDenied(denied);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'FORBIDDEN',
              message: 'fixture-private-server-detail',
            },
          }),
          { status: 403 },
        ),
      ),
    );
    await expect(api('/projects/fixture/read')).rejects.toThrow('FORBIDDEN');
    expect(denied).toHaveBeenCalledOnce();
    stop();
  });

  it('rejects a late parsed response after the session changes', async () => {
    let release: (value: object) => void = () => {};
    const body = new Promise<object>((resolve) => {
      release = resolve;
    });
    const json = vi.fn(() => body);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json }),
    );
    const pending = api('/projects/fixture/read');
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
    resetSessionRequests();
    release({ text: 'old-session-fixture' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
