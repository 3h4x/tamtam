import { readRedactedFileSync } from '@/lib/jobs/redacted-log-reader';
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

export function extractFailureLogDetail(
  logPath: string,
  options: FailureLogDetailOptions = {},
): string | null {
  try {
    const content = readRedactedFileSync(logPath);
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

    if (content.includes('"stream_event"')) {
      return options.partialStreamDetail ?? 'CLI streamed partial output but never emitted a final result.';
    }
    return options.jsonOnlyDetail ?? 'CLI wrote JSON to the log but never emitted a final result line.';
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return options.missingDetail === undefined ? 'log file missing' : options.missingDetail;
    }
    if (typeof options.readErrorDetail === 'function') return options.readErrorDetail(e);
    return options.readErrorDetail ?? `could not read log: ${errMsg(e)}`;
  }
}
