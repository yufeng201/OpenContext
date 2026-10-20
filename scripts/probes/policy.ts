/** Deliberately narrow protocol probe: never admits login, model turns or write tools. */
export function assertProbeRequest(
  method: string,
  params: Record<string, unknown>,
): void {
  if (method === 'initialize') return;
  if (
    method === 'thread/start' &&
    params['ephemeral'] === true &&
    params['sandbox'] === 'read-only' &&
    params['approvalPolicy'] === 'never'
  )
    return;
  if (
    method === 'mcpServer/tool/call' &&
    params['server'] === 'opencontext' &&
    ['context_search', 'context_read'].includes(String(params['tool']))
  )
    return;
  throw new Error('PROBE_METHOD_DENIED');
}
