import type { Catalog } from '@opencontext/state-sqlite';
/** Local SQLite sink only. Bounded replay, exponential backoff, explicit recovery circuit. */
export class AuditDispatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private failures = 0;
  private nextAttempt = 0;
  private fault = false;
  private suspended = false;
  constructor(privateCatalog: Catalog) {
    this.catalog = privateCatalog;
  }
  private readonly catalog: Catalog;
  start(): void {
    this.flush();
    this.timer = setInterval(() => this.flush(), 1000);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
  flush(now = Date.now()): number {
    if (this.suspended || now < this.nextAttempt) return 0;
    try {
      const delivered = this.catalog.deliverAuditBatch(100);
      this.fault = false;
      this.failures = 0;
      this.nextAttempt = 0;
      return delivered;
    } catch {
      this.fault = true;
      this.failures++;
      this.nextAttempt = now + Math.min(30000, 1000 * 2 ** (this.failures - 1));
      if (this.failures >= 5) this.suspended = true;
      return 0;
    }
  }
  retry(): number {
    this.suspended = false;
    this.nextAttempt = 0;
    this.failures = 0;
    return this.flush();
  }
  status() {
    try {
      const queue = this.catalog.auditPending();
      return {
        ok: !this.fault && queue.pending === 0,
        code: this.fault
          ? 'AUDIT_UNAVAILABLE'
          : queue.pending
            ? 'AUDIT_BACKLOG'
            : 'OK',
        pending: queue.pending,
        maxPending: queue.maxPending,
        suspended: this.suspended,
      };
    } catch {
      return {
        ok: false,
        code: 'AUDIT_UNAVAILABLE',
        pending: null,
        maxPending: 10000,
        suspended: this.suspended,
      };
    }
  }
}
