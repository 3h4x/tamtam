import { describe, it, expect } from 'vitest';
import { shouldFireAutoSubmit } from '@/components/TerminalTab';

// Regression: clicking "Work on" on an issue spawned two identical run jobs
// 1μs apart in dev because React StrictMode invokes mount effects twice.
// The guard ref records the last pending text we consumed and suppresses
// re-submissions for the same string.

describe('shouldFireAutoSubmit', () => {
  it('fires when not streaming and there is new pending text', () => {
    expect(shouldFireAutoSubmit(false, 'Work on #17', null)).toBe(true);
  });

  it('does not fire while streaming', () => {
    expect(shouldFireAutoSubmit(true, 'Work on #17', null)).toBe(false);
  });

  it('does not fire when there is no pending text', () => {
    expect(shouldFireAutoSubmit(false, null, null)).toBe(false);
    expect(shouldFireAutoSubmit(false, undefined, null)).toBe(false);
    expect(shouldFireAutoSubmit(false, '', null)).toBe(false);
  });

  it('does not fire when the pending text matches the last consumed text (StrictMode double-invoke)', () => {
    const text = 'Work on GitHub issue #17: "Improve pipeline…"';
    // First pass — guard has no record, should fire.
    expect(shouldFireAutoSubmit(false, text, null)).toBe(true);
    // Second pass (StrictMode re-run) — guard remembers, should NOT fire.
    expect(shouldFireAutoSubmit(false, text, text)).toBe(false);
  });

  it('fires again for a different pending text even after a previous submit', () => {
    const first = 'Work on #17';
    const second = 'Work on #11';
    expect(shouldFireAutoSubmit(false, second, first)).toBe(true);
  });

  it('streaming state overrides even new pending text', () => {
    expect(shouldFireAutoSubmit(true, 'new prompt', 'old prompt')).toBe(false);
  });

  it('treats whitespace-only strings as submittable — the guard is not a content validator', () => {
    // Dedup is purely on exact string equality. Whitespace trimming is the
    // caller's concern (handleSubmit handles empty-after-trim).
    expect(shouldFireAutoSubmit(false, '   ', null)).toBe(true);
  });
});
