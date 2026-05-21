const REDACTION = '[REDACTED]';

const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-api03-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  /["']?(?:api[_-]?key|token|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?[^"'\s,;]{8,}/gi,
  /\bhttps?:\/\/[^"'\s/]+:[^"'\s@]+@[^"'\s]+/gi,
  /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi,
  /\bhttps:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/[A-Za-z0-9/_-]+/gi,
];

const SECRET_ENV_KEY_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|WEBHOOK|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)/i;
const MIN_ENV_SECRET_LENGTH = 8;

function redactKnownPatterns(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match) => {
      if (/^Bearer\s+/i.test(match)) return `Bearer ${REDACTION}`;
      if (match.includes('://') && match.includes('@')) {
        return match.replace(/(https?:\/\/[^"'\s/:]+:)[^"'\s@]+(@)/i, `$1${REDACTION}$2`);
      }
      const assignment = match.match(/^([^:=]+[:=]\s*["']?)/);
      if (assignment) return `${assignment[1]}${REDACTION}`;
      return REDACTION;
    });
  }
  return output;
}

type EnvLike = Partial<NodeJS.ProcessEnv>;

// Memo the filtered secret values per env reference. For `process.env`
// (one singleton reference for the process lifetime), the env-key walk
// runs once and every subsequent redaction reuses the cached value list.
// Per-frame redaction in streaming CLI output was previously iterating
// every env entry (hundreds) just to discover the same ~5-20 secret
// values. Keyed on identity so callers that pass a custom env object
// (tests) still re-derive.
let _envCacheKey: EnvLike | null = null;
let _envCacheValues: string[] | null = null;

function getSecretEnvValues(env: EnvLike): string[] {
  if (env === _envCacheKey && _envCacheValues) return _envCacheValues;
  const values: string[] = [];
  for (const [key, rawValue] of Object.entries(env)) {
    if (!rawValue || rawValue.length < MIN_ENV_SECRET_LENGTH || !SECRET_ENV_KEY_RE.test(key)) continue;
    values.push(rawValue);
  }
  _envCacheKey = env;
  _envCacheValues = values;
  return values;
}

/** Invalidate the env-secret cache. Tests / hot reloads that mutate
 *  `process.env` after first use call this to force re-derivation. */
export function clearSecretEnvCache(): void {
  _envCacheKey = null;
  _envCacheValues = null;
}

function redactEnvValues(input: string, env: EnvLike = process.env): string {
  let output = input;
  for (const rawValue of getSecretEnvValues(env)) {
    output = output.split(rawValue).join(REDACTION);
  }
  return output;
}

export function redactSecrets(input: string, env?: EnvLike): string {
  if (!input) return input;
  return redactEnvValues(redactKnownPatterns(input), env);
}

export function redactLogFrame<T extends { content: string }>(frame: T, env?: EnvLike): T {
  const content = redactSecrets(frame.content, env);
  return content === frame.content ? frame : { ...frame, content };
}
