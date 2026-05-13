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

function redactEnvValues(input: string, env: EnvLike = process.env): string {
  let output = input;
  for (const [key, rawValue] of Object.entries(env)) {
    if (!rawValue || rawValue.length < MIN_ENV_SECRET_LENGTH || !SECRET_ENV_KEY_RE.test(key)) continue;
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
