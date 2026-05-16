import { describe, it, expect, vi } from 'vitest';
import {
  classifyOutcome,
  parseClassifierResponse,
  shouldClassify,
  tailLog,
} from '@/lib/jobs/outcome-classifier';

describe('tailLog', () => {
  it('returns the log unchanged when below the cap', () => {
    expect(tailLog('hello world', 64)).toBe('hello world');
  });
  it('returns only the trailing slice when above the cap', () => {
    const s = 'a'.repeat(100) + 'TAIL';
    expect(tailLog(s, 6)).toBe('aaTAIL');
  });
});

describe('parseClassifierResponse', () => {
  it('parses a bare JSON verdict', () => {
    expect(parseClassifierResponse('{"verdict":"done","reason":"finished"}')).toEqual({
      verdict: 'done',
      reason: 'finished',
    });
  });
  it('strips markdown fences', () => {
    const raw = '```json\n{"verdict":"asked_question","reason":"asks if to commit"}\n```';
    expect(parseClassifierResponse(raw)).toEqual({
      verdict: 'asked_question',
      reason: 'asks if to commit',
    });
  });
  it('ignores text around the JSON block', () => {
    const raw = 'Here is the verdict: {"verdict":"needs_continue","reason":"mid task"} done.';
    expect(parseClassifierResponse(raw)).toEqual({
      verdict: 'needs_continue',
      reason: 'mid task',
    });
  });
  it('rejects unknown verdicts', () => {
    expect(parseClassifierResponse('{"verdict":"maybe","reason":"x"}')).toBeNull();
  });
  it('rejects malformed JSON', () => {
    expect(parseClassifierResponse('not json at all')).toBeNull();
  });
});

describe('shouldClassify', () => {
  const base = { kind: 'run', sessionId: 'sess', finishedAt: 1 };
  it('accepts run jobs with a session and finishedAt', () => {
    expect(shouldClassify(base)).toBe(true);
  });
  it('accepts agent:* jobs', () => {
    expect(shouldClassify({ ...base, kind: 'agent:improve-speed' })).toBe(true);
  });
  it('rejects release-pipeline kinds', () => {
    expect(shouldClassify({ ...base, kind: 'test' })).toBe(false);
    expect(shouldClassify({ ...base, kind: 'review' })).toBe(false);
  });
  it('rejects running jobs', () => {
    expect(shouldClassify({ ...base, finishedAt: null })).toBe(false);
  });
  it('rejects jobs without a sessionId', () => {
    expect(shouldClassify({ ...base, sessionId: null as unknown as string })).toBe(false);
  });
});

describe('classifyOutcome', () => {
  function fakeFetch(body: { response?: string }, status = 200): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as typeof fetch;
  }

  it('returns a verdict on a happy path', async () => {
    const r = await classifyOutcome('agent says: all done.', {
      ollamaUrl: 'http://localhost:11434',
      model: 'gemma3:4b',
      deps: { fetch: fakeFetch({ response: '{"verdict":"done","reason":"signed off"}' }) },
    });
    expect(r?.verdict).toBe('done');
    expect(r?.reason).toBe('signed off');
    expect(r?.model).toBe('gemma3:4b');
    expect(typeof r?.classifiedAt).toBe('string');
  });

  it('returns null on transport error', async () => {
    const r = await classifyOutcome('tail', {
      ollamaUrl: 'http://localhost:11434',
      model: 'gemma3:4b',
      deps: { fetch: vi.fn().mockRejectedValue(new Error('econn')) as unknown as typeof fetch },
    });
    expect(r).toBeNull();
  });

  it('returns null on unparsable model output', async () => {
    const r = await classifyOutcome('tail', {
      ollamaUrl: 'http://localhost:11434',
      model: 'gemma3:4b',
      deps: { fetch: fakeFetch({ response: 'I think the answer is yes.' }) },
    });
    expect(r).toBeNull();
  });

  it('returns null on non-200 status', async () => {
    const r = await classifyOutcome('tail', {
      ollamaUrl: 'http://localhost:11434',
      model: 'gemma3:4b',
      deps: { fetch: fakeFetch({}, 500) },
    });
    expect(r).toBeNull();
  });
});
