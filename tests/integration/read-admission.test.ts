import { it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

import {
  ReadAdmission,
  READ_ADMISSION_LIMITS,
} from '../../apps/server/src/read-admission.ts';
import type { FileEntry } from '../../packages/contracts/src/index.ts';
const file: FileEntry = {
  fileId: 'f',
  revisionId: 'r',
  projectId: 'p',
  bindingId: 'b',
  slotKey: 'note',
  logicalPath: 'sources/note.md',
  bytes: 1048576,
  contentHash: 'a'.repeat(64),
  collection: 'sources',
  ownership: 'source_managed',
  freshness: 'fresh',
  tombstone: false,
  sourceVersion: 'v',
  createdAt: 'now',
  derivedFrom: [],
};
type FastifyRequest = Parameters<ReadAdmission['bind']>[0];
type FastifyReply = Parameters<ReadAdmission['bind']>[1];
function wire(admission: ReadAdmission) {
  const incoming = Object.assign(new EventEmitter(), { aborted: false });
  const events = new EventEmitter();
  const outgoing = Object.assign(events, {
    destroyed: false,
    writableFinished: false,
    destroy() {
      this.destroyed = true;
      events.emit('close');
      return this;
    },
  });
  const request = { raw: incoming } as FastifyRequest,
    reply = { raw: outgoing } as unknown as FastifyReply;
  admission.bind(request, reply);
  return { request, incoming, outgoing };
}
const zero = { heavy: 0, light: 0, lightProjects: 0 };
it('heavy global cap reserves an independent bounded light lane and enforces each project cap', () => {
  const a = new ReadAdmission(),
    h = wire(a);
  a.acquire(h.request, 'p', file, {});
  try {
    expect(() => a.acquire(wire(a).request, 'other', file, {})).toThrow(
      'RESOURCE_BUSY',
    );
    const small = { ...file, bytes: 4096 };
    for (const p of ['p', 'other'])
      for (let i = 0; i < 2; i++) a.acquire(wire(a).request, p, small, {});
    expect(a.snapshot()).toEqual({ heavy: 1, light: 4, lightProjects: 2 });
    expect(() => a.acquire(wire(a).request, 'p', small, {})).toThrow(
      'RESOURCE_BUSY',
    );
    expect(() => a.acquire(wire(a).request, 'third', small, {})).toThrow(
      'RESOURCE_BUSY',
    );
    h.outgoing.emit('finish');
    expect(a.snapshot().heavy).toBe(0);
    expect(a.snapshot().light).toBe(4);
  } finally {
    a.close();
  }
  expect(a.snapshot()).toEqual(zero);
});
it('one request is counted once, upgrades before large allocation, and never downgrades or changes scope', () => {
  const a = new ReadAdmission(),
    h = wire(a),
    l = wire(a);
  a.acquire(h.request, 'p', file, {});
  a.acquire(l.request, 'p', { ...file, bytes: 4 }, {});
  try {
    a.acquire(l.request, 'p', { ...file, bytes: 4 }, {});
    expect(a.snapshot()).toEqual({ heavy: 1, light: 1, lightProjects: 1 });
    expect(() => a.acquire(l.request, 'p', file, {})).toThrow('RESOURCE_BUSY');
    expect(a.snapshot().light).toBe(1);
    h.outgoing.emit('finish');
    a.acquire(l.request, 'p', file, {});
    expect(a.snapshot()).toEqual({ heavy: 1, light: 0, lightProjects: 0 });
    a.acquire(l.request, 'p', file, { maxBytes: 64 });
    expect(a.snapshot().heavy).toBe(1);
    expect(() => a.acquire(l.request, 'other', file, {})).toThrow('FORBIDDEN');
    l.outgoing.emit('finish');
    l.outgoing.emit('close');
    a.release(l.request);
    expect(a.snapshot()).toEqual(zero);
  } finally {
    a.close();
  }
});
it('selectors keep large object bodies in the light lane while large metadata cannot evade admission', () => {
  const a = new ReadAdmission();
  try {
    for (const p of ['p', 'other'])
      for (const options of [{ maxBytes: 64 }, { outline: false }])
        a.acquire(wire(a).request, p, { ...file, bytes: 16777216 }, options);
    expect(a.snapshot().light).toBe(READ_ADMISSION_LIMITS.light);
    const metadata = {
      ...file,
      bytes: 4,
      derivedFrom: Array.from({ length: 4000 }, () => ({
        fileId: 'f'.repeat(120),
        revisionId: 'r'.repeat(120),
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeGreaterThan(
      READ_ADMISSION_LIMITS.heavyBytes,
    );
    a.acquire(wire(a).request, 'third', metadata, { maxBytes: 4 });
    expect(a.snapshot().heavy).toBe(1);
  } finally {
    a.close();
  }
  expect(a.snapshot()).toEqual(zero);
});
it('finish, close, abort and errors release exactly once; closing denies new reads', () => {
  for (const event of ['finish', 'close', 'error', 'aborted']) {
    const a = new ReadAdmission(),
      w = wire(a);
    a.acquire(w.request, 'p', file, {});
    if (event === 'aborted') w.incoming.emit(event);
    else w.outgoing.emit(event, new Error('synthetic-only'));
    expect(a.snapshot()).toEqual(zero);
    w.outgoing.emit('close');
    a.release(w.request);
    expect(a.snapshot()).toEqual(zero);
    a.close();
    expect(() => a.acquire(wire(a).request, 'p', file, {})).toThrow(
      'RESOURCE_BUSY',
    );
  }
});
it('deadline closes a response before releasing and CPU-late checkpoints also terminate it', () => {
  vi.useFakeTimers();
  try {
    const a = new ReadAdmission(50),
      w = wire(a);
    a.acquire(w.request, 'p', file, {});
    vi.advanceTimersByTime(20);
    a.acquire(w.request, 'p', file, {});
    vi.advanceTimersByTime(30);
    expect(w.outgoing.destroyed).toBe(true);
    expect(a.snapshot()).toEqual(zero);
    a.close();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const b = new ReadAdmission(50),
      v = wire(b);
    b.acquire(v.request, 'p', file, {});
    clock.mockReturnValue(51);
    expect(() => b.check(v.request)).toThrow('TIMEOUT');
    expect(v.outgoing.destroyed).toBe(true);
    expect(b.snapshot()).toEqual(zero);
    b.close();
    clock.mockRestore();
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
it('resource lifetimes can only be tightened and already closed requests cannot acquire', () => {
  for (const timeout of [0, 9, 15001, Infinity, NaN])
    expect(() => new ReadAdmission(timeout)).toThrow('INVALID_TIMEOUT');
  const a = new ReadAdmission(),
    w = wire(a);
  w.outgoing.destroy();
  expect(() => a.acquire(w.request, 'p', file, {})).toThrow('CANCELLED');
  expect(a.snapshot()).toEqual(zero);
  a.close();
});
