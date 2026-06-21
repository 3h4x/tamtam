import { describe, it, expect } from 'vitest';
import { choreBaseScore, decayedScore, CHORE_SEVERITY } from '@/lib/orchestrator/initiative-score';

describe('initiative-score', () => {
  it('orders chore severities: build/type > failing-test > missing-test > todo > dep-bump > docs', () => {
    expect(CHORE_SEVERITY['type-error']).toBeGreaterThan(CHORE_SEVERITY['failing-test']);
    expect(CHORE_SEVERITY['failing-test']).toBeGreaterThan(CHORE_SEVERITY['missing-test']);
    expect(CHORE_SEVERITY['missing-test']).toBeGreaterThan(CHORE_SEVERITY['todo']);
    expect(CHORE_SEVERITY['todo']).toBeGreaterThan(CHORE_SEVERITY['dep-bump']);
    expect(CHORE_SEVERITY['dep-bump']).toBeGreaterThan(CHORE_SEVERITY['docs-gap']);
  });

  it('choreBaseScore returns 0 for unknown kinds', () => {
    expect(choreBaseScore('totally-unknown')).toBe(0);
  });

  it('decayedScore halves per attempt', () => {
    expect(decayedScore({ score: 100, attempts: 0 })).toBe(100);
    expect(decayedScore({ score: 100, attempts: 1 })).toBe(50);
    expect(decayedScore({ score: 100, attempts: 2 })).toBe(25);
  });
});
