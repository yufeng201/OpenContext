import type { FastifyReply, FastifyRequest } from 'fastify';
import { performance } from 'node:perf_hooks';
import type { FileEntry, ReadOptions } from '@opencontext/contracts';

export const READ_ADMISSION_LIMITS = {
  heavy: 1,
  light: 4,
  lightPerProject: 2,
  heavyBytes: 1024 * 1024,
  responseTimeoutMs: 15000,
} as const;
type Lease = {
  projectId: string;
  heavy: boolean;
  deadline: number;
  release(): void;
  abort(): void;
};
/** In-flight read response admission; not a heap/RSS quota or native CPU preemption. */
export class ReadAdmission {
  private readonly replies = new WeakMap<FastifyRequest, FastifyReply>();
  private readonly held = new WeakMap<FastifyRequest, Lease>();
  private readonly leases = new Set<Lease>();
  private readonly projects = new Map<string, number>();
  private heavy = 0;
  private light = 0;
  private closed = false;
  private readonly timeoutMs: number;
  constructor(timeoutMs: number = READ_ADMISSION_LIMITS.responseTimeoutMs) {
    this.timeoutMs = timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 15000)
      throw new Error('INVALID_TIMEOUT');
  }
  bind(request: FastifyRequest, reply: FastifyReply): void {
    this.replies.set(request, reply);
  }
  snapshot() {
    return {
      heavy: this.heavy,
      light: this.light,
      lightProjects: this.projects.size,
    };
  }
  private drop(projectId: string, heavy: boolean): void {
    if (heavy) this.heavy--;
    else {
      this.light--;
      const n = (this.projects.get(projectId) ?? 0) - 1;
      if (n) this.projects.set(projectId, n);
      else this.projects.delete(projectId);
    }
  }
  acquire(
    request: FastifyRequest,
    projectId: string,
    file: FileEntry,
    options: ReadOptions,
  ): void {
    if (this.closed) throw new Error('RESOURCE_BUSY');
    const reply = this.replies.get(request);
    if (
      !reply ||
      reply.raw.destroyed ||
      reply.raw.writableFinished ||
      request.raw.aborted
    )
      throw new Error('CANCELLED');
    this.check(request);
    const projected = Object.values(options).some(
      (value) => value !== undefined,
    );
    // Large metadata must not evade the heavy lane by requesting a tiny body.
    const heavy =
      (!projected && file.bytes >= READ_ADMISSION_LIMITS.heavyBytes) ||
      Buffer.byteLength(JSON.stringify(file)) >=
        READ_ADMISSION_LIMITS.heavyBytes;
    const prior = this.held.get(request);
    if (prior) {
      if (prior.projectId !== projectId) throw new Error('FORBIDDEN');
      if (!heavy || prior.heavy) return;
      // A grep/search request may encounter small, then large source objects.
      // Upgrade atomically before the first large allocation; never downgrade.
      if (this.heavy >= READ_ADMISSION_LIMITS.heavy)
        throw new Error('RESOURCE_BUSY');
      this.drop(projectId, false);
      this.heavy++;
      prior.heavy = true;
      return;
    }
    if (
      heavy
        ? this.heavy >= READ_ADMISSION_LIMITS.heavy
        : this.light >= READ_ADMISSION_LIMITS.light ||
          (this.projects.get(projectId) ?? 0) >=
            READ_ADMISSION_LIMITS.lightPerProject
    )
      throw new Error('RESOURCE_BUSY');
    if (heavy) this.heavy++;
    else {
      this.light++;
      this.projects.set(projectId, (this.projects.get(projectId) ?? 0) + 1);
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      reply.raw.off('finish', release);
      reply.raw.off('close', release);
      reply.raw.off('error', abort);
      request.raw.off('aborted', abort);
      this.drop(projectId, lease.heavy);
      this.held.delete(request);
      this.leases.delete(lease);
    };
    const abort = () => {
      reply.raw.destroy();
      release();
    };
    const lease: Lease = {
      projectId,
      heavy,
      deadline: performance.now() + this.timeoutMs,
      release,
      abort,
    };
    const timer = setTimeout(abort, this.timeoutMs);
    timer.unref();
    this.held.set(request, lease);
    this.leases.add(lease);
    reply.raw.once('finish', release);
    reply.raw.once('close', release);
    reply.raw.once('error', abort);
    request.raw.once('aborted', abort);
  }
  check(request: FastifyRequest): void {
    const lease = this.held.get(request);
    if (lease && performance.now() >= lease.deadline) {
      lease.abort();
      throw new Error('TIMEOUT');
    }
  }
  release(request: FastifyRequest): void {
    this.held.get(request)?.release();
  }
  close(): void {
    this.closed = true;
    for (const lease of [...this.leases]) lease.abort();
  }
}
