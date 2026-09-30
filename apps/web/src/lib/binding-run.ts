import type { Run } from '@opencontext/contracts';

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
