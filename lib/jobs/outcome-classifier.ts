// Runs the tail of a finished `run` / `agent:*` job's log through a small
// local LLM (default gemma3:4b on the existing retrieval Ollama instance)
// and classifies the model's final message into one of:
//
//   done            — work is complete, no further input expected
//   needs_continue  — work is unfinished; resuming the session should advance it
//   asked_question  — the model surfaced a clarifying question and stopped
//
// Used by the UI to highlight the Continue button (and, eventually, to
// auto-resume on `asked_question` within the cache-warm window).
//
// Design constraints:
// - Best-effort: must NEVER throw out of markDone. Errors are swallowed and
//   logged. A job that finished cleanly should not appear "stuck" because
//   the classifier hiccuped.
// - Fire-and-forget: the call site does not await; the result is written
//   to the job row's contextMeta and never blocks chaining.

import { openSync, fstatSync, readSync, closeSync } from 'fs';
import { getSettings } from '@/lib/shared/config';
import { updateJob } from '@/lib/jobs/job-storage';
import type { JobData } from '@/lib/jobs/job-storage';

export type OutcomeVerdict = 'done' | 'needs_continue' | 'asked_question';

export interface OutcomeClassification {
  verdict: OutcomeVerdict;
  reason: string;
  /** ISO-8601 timestamp this classification was produced at. */
  classifiedAt: string;
  /** Model identifier the classifier ran on. */
  model: string;
}

// Pull at most ~2 KB of trailing log. That's enough to cover the model's
// final assistant message in stream-json output without dragging the
// classifier into earlier turns.
const TAIL_BYTES = 2048;

const SYSTEM_INSTRUCTION = `You classify the final state of an AI coding agent's run.
Read the assistant's last message and output a single JSON object:
{"verdict":"done"|"needs_continue"|"asked_question","reason":"<≤120 chars>"}

Rules:
- "done": the agent finished the task and is signing off.
- "asked_question": the agent asked the user a clarifying question OR offered options ("would you like…", "should I…", "let me know…") and then stopped.
- "needs_continue": the agent described unfinished work, hit a blocker, or stopped mid-task without explicitly asking.

Output ONLY the JSON object. No prose, no markdown.`;

export function tailLog(log: string, bytes = TAIL_BYTES): string {
  if (log.length <= bytes) return log;
  return log.slice(-bytes);
}

export function parseClassifierResponse(raw: string): { verdict: OutcomeVerdict; reason: string } | null {
  // Ollama generate returns the model's text. Be liberal — strip any
  // markdown fences and grab the first {...} block.
  const fenced = raw.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  const slice = fenced.slice(start, end + 1);
  let parsed: unknown;
  try { parsed = JSON.parse(slice); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const v = obj.verdict;
  const r = obj.reason;
  if (v !== 'done' && v !== 'needs_continue' && v !== 'asked_question') return null;
  const reason = typeof r === 'string' ? r.slice(0, 200) : '';
  return { verdict: v, reason };
}

export interface ClassifyDeps {
  fetch?: typeof fetch;
}

// Hard cap on a single classification call. The classifier is gemma3:4b
// (or another small local model) on the existing retrieval Ollama
// instance; cold model load can pause for 10-20s, but a warm response on
// a 2 KB tail completes in well under a second. 30s is generous for the
// slow path while preventing the markDone hook from hanging forever if
// Ollama itself is wedged — the whole feature is best-effort and a
// timed-out fetch must NEVER block job finalization.
const CLASSIFY_TIMEOUT_MS = 30_000;

export async function classifyOutcome(
  logTail: string,
  options: { ollamaUrl: string; model: string; deps?: ClassifyDeps },
): Promise<OutcomeClassification | null> {
  const fetchFn = options.deps?.fetch ?? fetch;
  const prompt = `${SYSTEM_INSTRUCTION}\n\n---\nAGENT FINAL MESSAGE:\n${logTail}\n---\nJSON:`;
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
        options: { temperature: 0, num_predict: 128 },
      }),
      signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('[outcome-classifier] ollama fetch failed:', err);
    return null;
  }
  if (!res.ok) {
    console.warn(`[outcome-classifier] ollama returned ${res.status}`);
    return null;
  }
  let body: { response?: string };
  try {
    body = (await res.json()) as { response?: string };
  } catch (err) {
    console.warn('[outcome-classifier] ollama json parse failed:', err);
    return null;
  }
  const raw = body.response ?? '';
  const parsed = parseClassifierResponse(raw);
  if (!parsed) {
    console.warn('[outcome-classifier] unparsable model response:', raw.slice(0, 200));
    return null;
  }
  return {
    verdict: parsed.verdict,
    reason: parsed.reason,
    classifiedAt: new Date().toISOString(),
    model: options.model,
  };
}

export function shouldClassify(job: Pick<JobData, 'kind' | 'sessionId' | 'finishedAt'>): boolean {
  if (job.finishedAt === null) return false;
  if (!job.sessionId) return false;
  return job.kind === 'run' || job.kind.startsWith('agent:');
}

/**
 * Reads the tail of a finished job's log, classifies it, and merges the
 * verdict into the job's contextMeta. Best-effort: any failure is logged
 * and the job is left untouched.
 */
export async function classifyAndStashOutcome(job: JobData): Promise<OutcomeClassification | null> {
  if (!shouldClassify(job)) return null;
  // Gate on the enabled setting BEFORE touching the filesystem. With the
  // feature default-off, every finished run/agent job hits this path; we
  // must not pay a log read or string allocation for the disabled case.
  const settings = getSettings();
  if (!settings.outcome_classifier_enabled) return null;
  if (!job.logPath) return null;
  let logTail = '';
  try {
    // Seek to the end and read only the trailing TAIL_BYTES instead of
    // slurping the whole file — agent logs can be tens of MB.
    const fd = openSync(/*turbopackIgnore: true*/ job.logPath, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, TAIL_BYTES);
      const start = size - len;
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, start);
      logTail = buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    console.warn(`[outcome-classifier] could not read log for ${job.id}:`, err);
    return null;
  }
  if (!logTail.trim()) return null;
  const result = await classifyOutcome(logTail, {
    ollamaUrl: settings.retrieval_ollama_url,
    model: settings.outcome_classifier_model,
  });
  if (!result) return null;
  try {
    let meta: Record<string, unknown> = {};
    if (job.contextMeta) {
      try {
        const parsed = JSON.parse(job.contextMeta);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          meta = parsed as Record<string, unknown>;
        }
      } catch {}
    }
    meta.outcomeClassification = result;
    job.contextMeta = JSON.stringify(meta);
    updateJob(job);
  } catch (err) {
    console.warn(`[outcome-classifier] could not persist verdict for ${job.id}:`, err);
  }
  return result;
}
