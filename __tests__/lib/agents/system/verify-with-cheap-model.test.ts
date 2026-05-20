import { describe, expect, it, vi } from 'vitest';
import {
  verifyRetrievalWithCheapModel,
  __testing,
} from '@/lib/agents/system/verify-with-cheap-model';

const baseInput = {
  project: 'tamtam',
  query: 'release pipeline',
  snippets: [
    { sourceKind: 'project_doc', sourceId: 'docs/PIPELINE.md', text: 'The release pipeline runs test → review → fix.' },
    { sourceKind: 'project_doc', sourceId: 'CLAUDE.md', text: 'See docs/PIPELINE.md for the full state machine.' },
  ],
};

describe('verifyRetrievalWithCheapModel', () => {
  it('returns null when there are no snippets to check', async () => {
    const result = await verifyRetrievalWithCheapModel(
      { ...baseInput, snippets: [] },
      { ollamaUrl: 'http://localhost:11434', model: 'gemma3:4b' },
    );
    expect(result).toBeNull();
  });

  it('parses a clean OK verdict', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ response: '{"verdict":"ok","reason":"on-topic snippets"}' }),
    })) as unknown as typeof fetch;
    const result = await verifyRetrievalWithCheapModel(baseInput, {
      ollamaUrl: 'http://localhost:11434',
      model: 'gemma3:4b',
      deps: { fetch: fakeFetch },
    });
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('ok');
    expect(result!.reason).toBe('on-topic snippets');
    expect(result!.model).toBe('gemma3:4b');
  });

  it('parses a PROBLEM verdict', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ response: '{"verdict":"problem","reason":"snippets look random"}' }),
    })) as unknown as typeof fetch;
    const result = await verifyRetrievalWithCheapModel(baseInput, {
      ollamaUrl: 'http://localhost:11434',
      model: 'gemma3:4b',
      deps: { fetch: fakeFetch },
    });
    expect(result!.verdict).toBe('problem');
  });

  it('returns null when ollama is unreachable', async () => {
    const fakeFetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const result = await verifyRetrievalWithCheapModel(baseInput, {
      ollamaUrl: 'http://localhost:11434',
      model: 'gemma3:4b',
      deps: { fetch: fakeFetch },
    });
    expect(result).toBeNull();
  });

  it('returns null when ollama returns non-2xx', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const result = await verifyRetrievalWithCheapModel(baseInput, {
      ollamaUrl: 'http://localhost:11434',
      model: 'gemma3:4b',
      deps: { fetch: fakeFetch },
    });
    expect(result).toBeNull();
  });

  it('returns null when model output is unparsable', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ response: 'no json here, just prose' }),
    })) as unknown as typeof fetch;
    const result = await verifyRetrievalWithCheapModel(baseInput, {
      ollamaUrl: 'http://localhost:11434',
      model: 'gemma3:4b',
      deps: { fetch: fakeFetch },
    });
    expect(result).toBeNull();
  });

  it('builds a prompt that includes project, query, and snippets', () => {
    const prompt = __testing.buildPrompt(baseInput);
    expect(prompt).toContain('PROJECT: tamtam');
    expect(prompt).toContain('QUERY: release pipeline');
    expect(prompt).toContain('1. [project_doc:docs/PIPELINE.md]');
    expect(prompt).toContain('2. [project_doc:CLAUDE.md]');
  });
});
