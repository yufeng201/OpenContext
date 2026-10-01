import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@opencontext/contracts/audit';
import type { Principal } from '@opencontext/contracts';
export function auditRef(value: unknown): string | null {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? value
    : null;
}
export function auditEvent(
  action: string,
  principal: Principal | undefined,
  input: Record<string, unknown>,
  result: AuditEvent['result'],
  code: string,
  requestId: string | null,
  jobId: string | null = null,
): AuditEvent {
  return {
    id: randomUUID(),
    time: new Date().toISOString(),
    actor: principal
      ? { id: principal.id, role: principal.role }
      : { id: 'anonymous', role: 'anonymous' },
    action,
    target: {
      projectId: auditRef(input['projectId'] ?? input['id']),
      bindingId: auditRef(input['bindingId']),
      fileId: auditRef(input['fileId']),
      revisionId: auditRef(input['revisionId']),
      objectId: auditRef(input['objectId']),
      tokenId: auditRef(input['tokenId']),
    },
    result,
    code,
    requestId,
    jobId,
  };
}
export function auditAction(route: string, method: string): string {
  if (route === '/mcp') return 'mcp.request';
  if (route === '/api/audit') return 'audit.export';
  if (route.endsWith('/test-connection')) return 'source.diagnose';
  if (route.endsWith('/sync') || route.endsWith('/process'))
    return 'task.enqueue';
  if (route.includes('/imports'))
    return method === 'POST'
      ? 'import.create'
      : method === 'DELETE'
        ? 'import.delete'
        : 'import.list';
  if (route.includes('/bindings'))
    return method === 'DELETE'
      ? 'source.revoke'
      : method === 'POST'
        ? 'source.create'
        : 'source.list';
  if (route.includes('/tokens'))
    return method === 'DELETE' ? 'token.revoke' : 'token.create';
  if (route.endsWith('/read')) return 'file.read';
  if (route.endsWith('/search')) return 'file.search';
  if (route.endsWith('/tree')) return 'file.tree';
  if (route === '/api/projects')
    return method === 'POST' ? 'project.create' : 'project.list';
  if (route.endsWith('/runs')) return 'task.list';
  if (route === '/api/session')
    return method === 'POST'
      ? 'session.login'
      : method === 'DELETE'
        ? 'session.logout'
        : 'session.inspect';
  if (route === '/api/plugins') return 'plugin.list';
  if (route === '/api/readiness') return 'system.readiness';
  return 'api.request';
}
