import { describe, it, expect, beforeEach } from 'vitest';
import {
  tryClaimPipelineStartSlot,
  setPipelineStartSlotJob,
  releasePipelineStartSlot,
  _resetPipelineStartSlots,
} from '@/lib/pipeline/pipeline-start-slot';

describe('pipeline-start-slot', () => {
  beforeEach(() => {
    _resetPipelineStartSlots();
  });

  it('grants the slot to the first caller and rejects concurrent callers', () => {
    const a = tryClaimPipelineStartSlot('rel-1', 'review');
    expect(a.ok).toBe(true);

    const b = tryClaimPipelineStartSlot('rel-1', 'review');
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.jobId).toBeNull(); // holder hasn't created its job yet

    const c = tryClaimPipelineStartSlot('rel-1', 'review');
    expect(c.ok).toBe(false);
  });

  it('exposes the in-flight job id to losers once the holder sets it', () => {
    expect(tryClaimPipelineStartSlot('rel-1', 'review').ok).toBe(true);
    setPipelineStartSlotJob('rel-1', 'review', 'review-job-42');
    const loser = tryClaimPipelineStartSlot('rel-1', 'review');
    expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.jobId).toBe('review-job-42');
  });

  it('re-grants the slot after release', () => {
    expect(tryClaimPipelineStartSlot('rel-1', 'review').ok).toBe(true);
    expect(tryClaimPipelineStartSlot('rel-1', 'review').ok).toBe(false);
    releasePipelineStartSlot('rel-1', 'review');
    expect(tryClaimPipelineStartSlot('rel-1', 'review').ok).toBe(true);
  });

  it('keys independently per (release, kind)', () => {
    expect(tryClaimPipelineStartSlot('rel-1', 'review').ok).toBe(true);
    // Same release, different kind → independent slot.
    expect(tryClaimPipelineStartSlot('rel-1', 'test').ok).toBe(true);
    // Different release, same kind → independent slot.
    expect(tryClaimPipelineStartSlot('rel-2', 'review').ok).toBe(true);
    // Same (release, kind) is the only one that conflicts.
    expect(tryClaimPipelineStartSlot('rel-1', 'review').ok).toBe(false);
  });

  it('is a no-op for non-release (standalone) steps — never serializes', () => {
    expect(tryClaimPipelineStartSlot(null, 'review').ok).toBe(true);
    expect(tryClaimPipelineStartSlot(null, 'review').ok).toBe(true);
    expect(tryClaimPipelineStartSlot(undefined, 'test').ok).toBe(true);
    // set/release on a null release are safe no-ops
    setPipelineStartSlotJob(null, 'review', 'x');
    releasePipelineStartSlot(null, 'review');
  });

  it('serializes a burst of concurrent claims to exactly one winner', () => {
    // Mirrors the bug: N orchestrator resumes all dispatch review at once.
    const results = Array.from({ length: 8 }, () =>
      tryClaimPipelineStartSlot('rel-burst', 'review'),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
  });
});
