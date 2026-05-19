import { describe, it, expect } from 'vitest';
import { extractActionBlock, parseAgentActions } from '@/lib/agents/action-block-parser';

describe('extractActionBlock', () => {
  it('returns missing when text has no fenced block', () => {
    const r = extractActionBlock('Just some prose. No fence here.');
    expect(r).toEqual({ ok: false, reason: 'missing' });
  });

  it('returns missing on empty input', () => {
    expect(extractActionBlock('')).toEqual({ ok: false, reason: 'missing' });
    expect(extractActionBlock(undefined as unknown as string)).toEqual({ ok: false, reason: 'missing' });
  });

  it('extracts a single block from the end', () => {
    const text = 'Some context text.\n\n```tamtam-actions\n{"actions":[]}\n```';
    const r = extractActionBlock(text);
    expect(r).toEqual({ ok: true, raw: '{"actions":[]}' });
  });

  it('returns multiple when more than one block is present', () => {
    const text = '```tamtam-actions\n{"actions":[]}\n```\n\n```tamtam-actions\n{"actions":[]}\n```';
    expect(extractActionBlock(text)).toEqual({ ok: false, reason: 'multiple' });
  });

  it('ignores blocks tagged with a different language', () => {
    const text = '```json\n{"actions":[]}\n```';
    expect(extractActionBlock(text)).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('parseAgentActions', () => {
  it('returns missing when no block present', () => {
    const r = parseAgentActions('hello world');
    expect(r).toEqual({ ok: false, reason: 'missing' });
  });

  it('parses an empty actions list', () => {
    const text = '```tamtam-actions\n{"actions":[]}\n```';
    const r = parseAgentActions(text);
    expect(r).toEqual({ ok: true, actions: [] });
  });

  it('parses a complete issue-close action with comment', () => {
    const text = '```tamtam-actions\n' +
      JSON.stringify({
        actions: [
          { type: 'issue-close', number: 308, reason: 'not planned', comment: 'Stale.' },
        ],
      }) + '\n```';
    const r = parseAgentActions(text);
    expect(r).toMatchObject({
      ok: true,
      actions: [
        { type: 'issue-close', number: 308, reason: 'not planned', comment: 'Stale.' },
      ],
    });
  });

  it('parses an issue-close action without a comment', () => {
    const text = '```tamtam-actions\n{"actions":[{"type":"issue-close","number":7,"reason":"completed"}]}\n```';
    const r = parseAgentActions(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actions[0]).toEqual({ type: 'issue-close', number: 7, reason: 'completed' });
    }
  });

  it('parses mixed actions in declaration order', () => {
    const text = '```tamtam-actions\n' +
      JSON.stringify({
        actions: [
          { type: 'issue-comment', number: 42, body: 'Starting work now.' },
          { type: 'issue-label', number: 42, addLabels: ['needs-info'], removeLabels: [] },
          { type: 'checkout-default' },
        ],
      }) + '\n```';
    const r = parseAgentActions(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actions.map((a) => a.type)).toEqual([
        'issue-comment', 'issue-label', 'checkout-default',
      ]);
    }
  });

  it('defaults issue-label addLabels/removeLabels to empty arrays when absent', () => {
    const text = '```tamtam-actions\n{"actions":[{"type":"issue-label","number":1}]}\n```';
    const r = parseAgentActions(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actions[0]).toEqual({ type: 'issue-label', number: 1, addLabels: [], removeLabels: [] });
    }
  });

  it('rejects malformed JSON', () => {
    const text = '```tamtam-actions\n{"actions": [malformed}\n```';
    const r = parseAgentActions(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid-json');
  });

  it('rejects unknown action type', () => {
    const text = '```tamtam-actions\n{"actions":[{"type":"foo","number":1}]}\n```';
    const r = parseAgentActions(text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('invalid-schema');
      expect(r.detail).toContain('foo');
    }
  });

  it('rejects negative issue number', () => {
    const text = '```tamtam-actions\n{"actions":[{"type":"issue-close","number":-1,"reason":"completed"}]}\n```';
    const r = parseAgentActions(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid-schema');
  });

  it('rejects invalid issue-close reason', () => {
    const text = '```tamtam-actions\n{"actions":[{"type":"issue-close","number":1,"reason":"resolved"}]}\n```';
    const r = parseAgentActions(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid-schema');
  });

  it('rejects multiple blocks', () => {
    const text = '```tamtam-actions\n{"actions":[]}\n```\n```tamtam-actions\n{"actions":[]}\n```';
    const r = parseAgentActions(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('multiple');
  });

  it('parses an issue-edit-body action', () => {
    const text = '```tamtam-actions\n{"actions":[{"type":"issue-edit-body","kind":"pr","number":12,"body":"new body"}]}\n```';
    const r = parseAgentActions(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actions[0]).toEqual({ type: 'issue-edit-body', kind: 'pr', number: 12, body: 'new body' });
    }
  });

  it('rejects issue-edit-body with invalid kind', () => {
    const text = '```tamtam-actions\n{"actions":[{"type":"issue-edit-body","kind":"discussion","number":12,"body":"x"}]}\n```';
    const r = parseAgentActions(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid-schema');
  });

  it('tolerates a stray non-JSON line interleaved inside the fence (e.g. INFO from a stream forwarder)', () => {
    // Mirrors the issue-cruncher failure case the user reported: a structurally
    // valid action block with one rogue token in the middle. The sanitizer
    // strips the offending line and retries; the result is the same actions a
    // clean emit would produce.
    const text = [
      '```tamtam-actions',
      '{',
      '  "actions": [',
      '    {',
      '      "type": "issue-close",',
      '      "number": 321,',
      '      "reason": "not planned",',
      'INFO',                                                   // ← noise line
      '      "comment": "stale issue, closing."',
      '    },',
      '    {',
      '      "type": "checkout-default"',
      '    }',
      '  ]',
      '}',
      '```',
    ].join('\n');
    const r = parseAgentActions(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.actions).toHaveLength(2);
    expect(r.actions[0]).toMatchObject({ type: 'issue-close', number: 321, reason: 'not planned' });
    expect(r.actions[1]).toMatchObject({ type: 'checkout-default' });
  });

  it('still rejects genuinely malformed JSON (no JSON-shaped recovery possible)', () => {
    const text = '```tamtam-actions\n{ this is not json at all }\n```';
    const r = parseAgentActions(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-json');
  });
});
