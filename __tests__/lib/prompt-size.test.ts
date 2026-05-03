import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { measurePrompt, estimateTokens, checkPromptSize } from '@/lib/jobs/prompt-size';

describe('measurePrompt', () => {
  it('returns UTF-8 byte length', () => {
    expect(measurePrompt('hello')).toBe(5);
    expect(measurePrompt('')).toBe(0);
    expect(measurePrompt('café')).toBe(5); // é is 2 bytes
  });
});

describe('estimateTokens', () => {
  it('approximates bytes / 4', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(40)).toBe(10);
    expect(estimateTokens(200_000)).toBe(50_000);
  });
});

describe('checkPromptSize', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const origEnv = process.env.TAMTAM_PROMPT_WARN_BYTES;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    if (origEnv === undefined) delete process.env.TAMTAM_PROMPT_WARN_BYTES;
    else process.env.TAMTAM_PROMPT_WARN_BYTES = origEnv;
  });

  it('does not warn under default threshold', () => {
    delete process.env.TAMTAM_PROMPT_WARN_BYTES;
    checkPromptSize('job1', 'review', 1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when prompt exceeds threshold', () => {
    process.env.TAMTAM_PROMPT_WARN_BYTES = '500';
    checkPromptSize('job2', 'agent:tests', 5000);
    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('job2');
    expect(msg).toContain('agent:tests');
    expect(msg).toContain('5000');
  });

  it('falls back to default when env var is invalid', () => {
    process.env.TAMTAM_PROMPT_WARN_BYTES = 'not-a-number';
    checkPromptSize('job3', 'review', 1000);
    expect(warnSpy).not.toHaveBeenCalled(); // 1000 < default 200000
  });
});
