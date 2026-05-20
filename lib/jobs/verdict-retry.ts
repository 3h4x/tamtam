// One-shot verdict-extraction retry. When the primary `getVerdict` parser
// fails on a finished review log, we burn a tiny fast-tier CLI call to
// classify the existing review text rather than wasting the entire run by
// defaulting to NEEDS ATTENTION (which costs another full review + fix
// iteration). Gated by the `review_retry_on_parse_failure` setting.

import { spawn } from 'child_process';
import { readParsedLog } from './verdict';
import { getSettings, getPermissionModeFlag } from '@/lib/shared/config';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { buildChildEnv } from '@/lib/shared/child-env';
import type { JobData } from './types';
import { isCliProvider, type CliProvider } from '@/lib/usage/cli-providers';

const TIMEOUT_MS = 30_000;
const MAX_TAIL_CHARS = 4000;

function classify(text: string): string | null {
  const t = text.trim().toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();
  if (t === 'LGTM') return 'LGTM';
  if (t === 'NEEDS ATTENTION') return 'NEEDS ATTENTION';
  if (t === 'DO NOT SHIP') return 'DO NOT SHIP';
  // Final permissive pass — pick the first matching token. Models
  // sometimes wrap the answer in a sentence even at temperature 0.
  if (/\bDO NOT SHIP\b/.test(t)) return 'DO NOT SHIP';
  if (/\bNEEDS ATTENTION\b/.test(t)) return 'NEEDS ATTENTION';
  if (/\bLGTM\b/.test(t)) return 'LGTM';
  return null;
}

/**
 * Run a tiny provider-matched CLI call against the review log tail to recover
 * a verdict. Returns null on any failure (no CLI bin, timeout, unparseable output)
 * so callers can fall back to their existing default. Never throws.
 */
export async function retryVerdictWithClaude(job: JobData): Promise<string | null> {
  const settings = getSettings();
  if (!settings.review_retry_on_parse_failure) return null;

  const log = readParsedLog(job, 100_000);
  if (!log.trim()) return null;

  const tail = log.slice(-MAX_TAIL_CHARS);
  const prompt =
    'You are extracting a code-review verdict from the end of a review log. ' +
    'The reviewer was asked to end with one of three exact tokens: ' +
    'LGTM, NEEDS ATTENTION, or DO NOT SHIP. They forgot to do so cleanly.\n\n' +
    'Read the review tail below and reply with EXACTLY one of these three ' +
    'strings, on its own, with no other words, no punctuation, no markdown:\n\n' +
    '    LGTM\n' +
    '    NEEDS ATTENTION\n' +
    '    DO NOT SHIP\n\n' +
    'Choose LGTM only if the reviewer indicated the change is safe to ship. ' +
    'Choose DO NOT SHIP only for serious risk (data loss, security, breakage). ' +
    'Otherwise choose NEEDS ATTENTION.\n\n' +
    '--- review tail ---\n' +
    tail;

  const provider: CliProvider = isCliProvider(job.provider) ? job.provider : 'claude';
  const cliBin = resolveCliBin(provider, settings);
  const cliEnv = resolveCliEnv(provider, settings);

  const result = await new Promise<string | null>((resolve) => {
    let out = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    let child;
    try {
      const [permFlag, permValue] = getPermissionModeFlag().split(' ');
      child = spawn(cliBin, ['--print', '--model', 'fast', permFlag, permValue], {
        env: buildChildEnv(cliEnv),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      console.log(`[verdict-retry] spawn failed for ${job.id}:`, e);
      finish(null);
      return;
    }

    timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      console.log(`[verdict-retry] timed out after ${TIMEOUT_MS}ms for ${job.id}`);
      finish(null);
    }, TIMEOUT_MS);

    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', (e) => {
      console.log(`[verdict-retry] error for ${job.id}:`, e.message);
      finish(null);
    });
    child.on('close', () => finish(classify(out)));

    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch (e) {
      console.log(`[verdict-retry] stdin write failed for ${job.id}:`, e);
      finish(null);
    }
  });

  if (result) {
    console.log(`[verdict-retry] recovered verdict for ${job.id}: ${result}`);
  }
  return result;
}
