import { describe, it, expect } from 'vitest';
import { mineCandidates } from '@/lib/orchestrator/initiative-miner';

describe('mineCandidates', () => {
  it('maps findings to mining candidates with severity scores', () => {
    const out = mineCandidates({
      project: 'proj',
      findings: [
        { kind: 'lint', title: 'Fix lint', rationale: '3 errors', prompt: 'fix lint', dedupKey: 'lint:global' },
        { kind: 'todo', title: 'Resolve TODO', rationale: 'in foo.ts', prompt: 'do todo', dedupKey: 'todo:foo.ts:12' },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ project: 'proj', source: 'mining', kind: 'lint', score: 100 });
    expect(out[1]).toMatchObject({ kind: 'todo', score: 40 });
  });

  it('drops malformed findings and de-dupes within the batch (last wins)', () => {
    const out = mineCandidates({
      project: 'proj',
      findings: [
        { kind: '', title: 't', rationale: 'r', prompt: 'p', dedupKey: 'd' },
        { kind: 'lint', title: 'old', rationale: 'r', prompt: 'p', dedupKey: 'lint:global' },
        { kind: 'lint', title: 'new', rationale: 'r', prompt: 'p', dedupKey: 'lint:global' },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('new');
  });
});
