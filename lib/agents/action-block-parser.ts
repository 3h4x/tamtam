// Extract and validate the agent-emitted action block from a run's final
// assistant text. Pairs with `action-schema.ts` (the contract) and
// `action-orchestrator.ts` (the dispatcher).
//
// Grammar (must match what the issue-cruncher prompt tells the agent to emit):
//
//   ```tamtam-actions
//   { "actions": [ ... ] }
//   ```
//
// Multiple blocks → parse failure (ambiguous intent — refuse to act on a
// non-deterministic choice). No block → `missing` (silent no-op; the
// orchestrator skips agents that don't emit one).

import { validateAgentActions, type AgentActionList } from '@/lib/agents/action-schema';

const FENCE_RE = /```tamtam-actions\s*\n([\s\S]*?)\n```/g;

export type ExtractResult =
  | { ok: true; raw: string }
  | { ok: false; reason: 'missing' | 'multiple' };

export function extractActionBlock(assistantText: string): ExtractResult {
  if (typeof assistantText !== 'string' || !assistantText.length) {
    return { ok: false, reason: 'missing' };
  }
  // `matchAll` iterates with its own internal lastIndex (no shared state on
  // the module-scope regex) and short-circuits as soon as we see a second
  // match — avoids the manual `lastIndex = 0` reset and any concurrent-call
  // fragility a /g regex with mutable state would otherwise carry.
  let first: string | null = null;
  for (const m of assistantText.matchAll(FENCE_RE)) {
    if (first !== null) return { ok: false, reason: 'multiple' };
    first = m[1];
  }
  if (first === null) return { ok: false, reason: 'missing' };
  return { ok: true, raw: first };
}

export type ParseResult =
  | { ok: true; actions: AgentActionList }
  | { ok: false; reason: 'missing' | 'multiple' | 'invalid-json' | 'invalid-schema'; detail?: string };

// Strip lines inside the fence that are clearly not part of the JSON object —
// stream-json renderers, log forwarders, and UI overlays have been observed
// to interleave plain words (e.g. `INFO`) between JSON lines. A line is "JSON
// shaped" if a structural token follows leading whitespace: `{`, `}`, `[`,
// `]`, `"`, a digit, a sign, or the keywords true/false/null. Anything else
// (bare identifiers, log prefixes, sentinel words) is dropped before parsing.
// This is intentionally narrow: it never tries to "repair" broken JSON, only
// to remove interleaved noise lines that obviously can't be inside a JSON
// object's syntax tree. If the result still doesn't parse, we return
// invalid-json so the caller knows the agent's emit was genuinely malformed.
function sanitizeFencedJson(raw: string): string {
  const lines = raw.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      kept.push(line);
      continue;
    }
    // Allow if the first non-whitespace char looks like JSON syntax.
    if (/^\s*(?:[{},:"0-9+.-]|\[|\])/.test(line)) {
      kept.push(line);
      continue;
    }
    // Allow JSON literal words at the start of the trimmed line.
    if (/^(true|false|null)\b/.test(trimmed)) {
      kept.push(line);
      continue;
    }
    // Otherwise this line is noise (e.g. a stray `INFO` token from a stream
    // logger or UI overlay). Drop it silently.
  }
  return kept.join('\n');
}

export function parseAgentActions(assistantText: string): ParseResult {
  const extracted = extractActionBlock(assistantText);
  if (!extracted.ok) return extracted;

  // Two-stage parse: try the raw text first (fast path, no allocation diff),
  // then a sanitized version that strips interleaved non-JSON lines. We don't
  // sanitize unconditionally so well-formed payloads never get mutated.
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.raw);
  } catch (rawErr) {
    const sanitized = sanitizeFencedJson(extracted.raw);
    if (sanitized !== extracted.raw) {
      try {
        parsed = JSON.parse(sanitized);
      } catch {
        // Both attempts failed — surface the original error so the operator
        // sees a real diagnostic, not a sanitization-induced one.
        return {
          ok: false,
          reason: 'invalid-json',
          detail: rawErr instanceof Error ? rawErr.message : String(rawErr),
        };
      }
    } else {
      return {
        ok: false,
        reason: 'invalid-json',
        detail: rawErr instanceof Error ? rawErr.message : String(rawErr),
      };
    }
  }
  const validated = validateAgentActions(parsed);
  if (!validated.ok) {
    return {
      ok: false,
      reason: 'invalid-schema',
      detail: validated.detail,
    };
  }
  return { ok: true, actions: validated.value.actions };
}
