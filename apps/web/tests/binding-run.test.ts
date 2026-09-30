import { describe, expect, it } from 'vitest';
import type { Run } from '@opencontext/contracts';
import { selectBindingRun } from '../src/lib/binding-run';

function run(id: string, state: Run['state'], bindingId = 'binding-a'): Run {
  return {
    id,
    projectId: 'project-a',
    bindingId,
    kind: 'sync',
    state,
    fence: '1',
    incarnation: 'fixture',
    inputCommit: null,
    resultCommit: state === 'published' ? 'commit-a' : null,
    error: null,
    createdAt: '2026-09-30T00:00:00.000Z',
  };
}

describe('binding run status across clients', () => {
  it.each(['queued', 'running'] as const)(
    "shows another client's %s run after the local action completed",
    (state) => {
      const localAccepted = run('local', 'queued');
      const localCompleted = run('local', 'published');
      const external = { ...run('external', state), kind: 'process' as const };

      expect(
        selectBindingRun('binding-a', [localCompleted], localAccepted),
      ).toBe(localCompleted);
      expect(
        selectBindingRun(
          'binding-a',
          [localCompleted, external],
          localAccepted,
        ),
      ).toBe(external);
    },
  );

  it('retains the accepted action until the first authoritative poll arrives', () => {
    const accepted = run('local', 'queued');
    expect(selectBindingRun('binding-a', [], accepted)).toBe(accepted);
    const failed = {
      ...accepted,
      state: 'failed' as const,
      error: 'GIT_FAILED',
    };
    expect(selectBindingRun('binding-a', [failed], accepted)).toBe(failed);
  });

  it('does not let another binding make this row busy', () => {
    const completed = run('local', 'published');
    const other = run('other', 'running', 'binding-b');
    expect(selectBindingRun('binding-a', [other, completed], completed)).toBe(
      completed,
    );
    expect(selectBindingRun('binding-a', [other], other)).toBeUndefined();
  });
});
