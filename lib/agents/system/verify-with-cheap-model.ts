// Cheap-LLM verifier for retrieval quality. Reuses the same Ollama
// `/api/generate` pattern as the outcome classifier — we keep them
// distinct so the JSON-output prompt shape stays specialized.
// Failure modes (ollama down, parse error) return null so the caller can
// record a degraded-but-successful job without blowing up the cron run.

const PREVIEW_CHARS_PER_SNIPPET = 200;
const PROMPT_HARD_CAP = 2048;

const VERIFY_INSTRUCTION = `You audit retrieval result quality for a project's documentation index.
Given a sample query, the project name, and the top retrieved snippets, decide
if the snippets look like real content from this project and roughly on-topic
for the query. Output a single JSON object:
{"verdict":"ok"|"problem","reason":"<≤120 chars>"}

Rules:
- "ok": snippets look like real prose/code from this project, and at least one is roughly on-topic for the query.
- "problem": snippets are empty, random noise, look like they came from a different project, or are obvious duplicates of each other.

Output ONLY the JSON object. No prose, no markdown.`;

export interface VerifyInput {
  project: string;
  query: string;
  snippets: { sourceKind: string; sourceId: string; text: string }[];
}

export type VerifyVerdict = 'ok' | 'problem';

export interface VerifyResult {
  verdict: VerifyVerdict;
  reason: string;
  model: string;
  verifiedAt: string;
}

export interface VerifyDeps {
  fetch?: typeof fetch;
}

function buildPrompt(input: VerifyInput): string {
  const numbered = input.snippets.map((s, i) => {
    const preview = s.text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS_PER_SNIPPET);
    return `${i + 1}. [${s.sourceKind}:${s.sourceId}] ${preview}`;
  }).join('\n');
  const head = `${VERIFY_INSTRUCTION}\n\n---\nPROJECT: ${input.project}\nQUERY: ${input.query}\nSNIPPETS:\n`;
  const tail = '\n---\nJSON:';
  let prompt = `${head}${numbered}${tail}`;
  if (prompt.length > PROMPT_HARD_CAP) {
    // Trim from the snippets block in the middle; head + tail stay intact.
    const overflow = prompt.length - PROMPT_HARD_CAP;
    const trimmedNumbered = numbered.slice(0, Math.max(0, numbered.length - overflow));
    prompt = `${head}${trimmedNumbered}${tail}`;
  }
  return prompt;
}

function parseVerifyResponse(raw: string): { verdict: VerifyVerdict; reason: string } | null {
  const fenced = raw.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(fenced.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const v = obj.verdict;
  const r = obj.reason;
  if (v !== 'ok' && v !== 'problem') return null;
  return { verdict: v, reason: typeof r === 'string' ? r.slice(0, 200) : '' };
}

// Hard cap on a single verifier call. Matches the timeout used by the
// outcome classifier (both hit `/api/generate` on the same Ollama
// instance) — generous for cold-model load but bounded so a wedged
// Ollama can't stall the reindex-corpus cron task that calls this.
const VERIFY_TIMEOUT_MS = 30_000;

export async function verifyRetrievalWithCheapModel(
  input: VerifyInput,
  options: { ollamaUrl: string; model: string; deps?: VerifyDeps },
): Promise<VerifyResult | null> {
  if (input.snippets.length === 0) return null;
  const fetchFn = options.deps?.fetch ?? fetch;
  const prompt = buildPrompt(input);
  let res: Response;
  try {
    res = await fetchFn(`${options.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0, num_predict: 96 },
      }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('[retrieval-verify] ollama fetch failed:', err);
    return null;
  }
  if (!res.ok) {
    console.warn(`[retrieval-verify] ollama returned ${res.status}`);
    return null;
  }
  let body: { response?: string };
  try {
    body = (await res.json()) as { response?: string };
  } catch (err) {
    console.warn('[retrieval-verify] ollama json parse failed:', err);
    return null;
  }
  const parsed = parseVerifyResponse(body.response ?? '');
  if (!parsed) {
    console.warn('[retrieval-verify] unparsable model response:', (body.response ?? '').slice(0, 200));
    return null;
  }
  return {
    verdict: parsed.verdict,
    reason: parsed.reason,
    model: options.model,
    verifiedAt: new Date().toISOString(),
  };
}

export const __testing = { buildPrompt, parseVerifyResponse };
