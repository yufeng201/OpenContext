import type { Run } from '@opencontext/contracts';

export function runLabel(state: Run['state']) {
  return {
    queued: '等待执行',
    running: '执行中',
    published: '内容已发布',
    failed: '执行失败',
    superseded: '输入已更新',
  }[state];
}

// The latest local action is feedback, not the authority for whether the
// binding is currently busy: another client can enqueue a newer run.
export function selectBindingRun(
  bindingId: string,
  runs: readonly Run[],
  lastAction?: Run,
): Run | undefined {
  return (
    runs.find(
      (run) =>
        run.bindingId === bindingId &&
        (run.state === 'queued' || run.state === 'running'),
    ) ??
    runs.find(
      (run) => run.bindingId === bindingId && run.id === lastAction?.id,
    ) ??
    (lastAction?.bindingId === bindingId ? lastAction : undefined)
  );
}
