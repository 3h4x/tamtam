import { readRedactedFileSync, readRedactedTailSync } from '@/lib/jobs/redacted-log-reader';
import { errMsg } from '@/lib/shared/types';

const TS_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?:\s/;

interface FailureLogDetailOptions {
  missingDetail?: string | null;
  readErrorDetail?: string | ((error: unknown) => string | null);
  emptyDetail?: string;
  wrapperOnlyDetail?: string;
  partialStreamDetail?: string;
  jsonOnlyDetail?: string;
  includeNonJsonDetail?: boolean;
}

function extractResultTextDetail(content: string): string | null {
  const collected: string[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('[tamtam]')) continue;
    const tsMatch = line.match(TS_PREFIX_RE);
    const body = tsMatch ? line.slice(tsMatch[0].length) : line;

    try {
      const parsed = JSON.parse(body) as {
        type?: string;
        result?: unknown;
      };
      const candidate = typeof parsed.result === 'string'
        ? parsed.result
        : null;
      if (candidate && candidate.trim()) collected.push(candidate.trim());
    } catch {
      continue;
    }
  }

  if (collected.length === 0) return null;

  const lines = collected
    .join('\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  return lines.slice(-20).join('\n');
}

export function extractFailureLogDetail(
  logPath: string,
  options: FailureLogDetailOptions = {},
): string | null {
  try {
    return extractFailureLogDetailFromContent(readRedactedFileSync(logPath), options);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return options.missingDetail === undefined ? 'log file missing' : options.missingDetail;
    }
    if (typeof options.readErrorDetail === 'function') return options.readErrorDetail(e);
    return options.readErrorDetail ?? `could not read log: ${errMsg(e)}`;
  }
}

export function extractFailureLogDetailFromTail(
  logPath: string,
  maxBytes: number,
  options: FailureLogDetailOptions = {},
): string | null {
  try {
    return extractFailureLogDetailFromContent(readRedactedTailSync(logPath, maxBytes), options);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return options.missingDetail === undefined ? 'log file missing' : options.missingDetail;
    }
    if (typeof options.readErrorDetail === 'function') return options.readErrorDetail(e);
    return options.readErrorDetail ?? `could not read log: ${errMsg(e)}`;
  }
}

export function extractFailureLogDetailFromContent(
  content: string,
  options: FailureLogDetailOptions = {},
): string | null {
  if (!content.trim()) {
    return options.emptyDetail ?? 'log file empty - CLI exited without writing anything.';
  }

  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  const wrapperOnly = lines.every((line) => line.startsWith('[tamtam]'));
  if (wrapperOnly) {
    return options.wrapperOnlyDetail ?? 'CLI exited immediately without producing any output.';
  }

  const nonJson: string[] = [];
  for (const line of lines) {
    if (line.startsWith('[tamtam]')) continue;
    const tsMatch = line.match(TS_PREFIX_RE);
    const body = tsMatch ? line.slice(tsMatch[0].length) : line;
    try {
      JSON.parse(body);
    } catch {
      nonJson.push(line);
    }
  }
  if (nonJson.length > 0) {
    return options.includeNonJsonDetail ? nonJson.slice(-20).join('\n') : null;
  }

  const resultTextDetail = extractResultTextDetail(content);
  if (resultTextDetail) return resultTextDetail;

  if (content.includes('"stream_event"')) {
    return options.partialStreamDetail ?? 'CLI streamed partial output but never emitted a final result.';
  }
  return options.jsonOnlyDetail ?? 'CLI wrote JSON to the log but never emitted a final result line.';
}
