import { NextRequest } from 'next/server';
import { existsSync, readFileSync, watch, openSync, readSync, fstatSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getJob, probeJobStatus } from '@/lib/jobs/job-storage';
import { parseStreamLines, createParseState, type ParseState } from '@/lib/jobs/claude-stream-parser';
import { errMsg } from '@/lib/shared/types';
import { redactSecrets } from '@/lib/shared/log-redaction';
import { readRedactedFileSync } from '@/lib/jobs/redacted-log-reader';

// Poll interval for the fs.watch fallback. Read once at module load so tests
// can shrink it via TAMTAM_STREAM_POLL_MS to keep the poll-path test fast.
// Defaults to 1000ms in production; clamped to a positive integer.
const STREAM_POLL_MS = (() => {
  const raw = Number(process.env.TAMTAM_STREAM_POLL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1000;
})();

function getLogPath(jobId: string): string {
  const job = getJob(jobId);
  if (job?.logPath) return job.logPath;
  return join(homedir(), '.tamtam', 'jobs', `${jobId}.log`);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const logPath = getLogPath(jobId);
  const encoder = new TextEncoder();
  const raw = request.nextUrl.searchParams.get('raw') === '1';
  // passthrough mode: non-JSON lines → `raw` SSE events (monospace), JSON lines → parsed Claude events.
  // Used for aggregate logs like release that mix plain shell output with NDJSON review sections.
  const passthrough = !raw && request.nextUrl.searchParams.get('passthrough') === '1';

  const stream = new ReadableStream({
    start(controller) {
      let offset = 0;

      function sendRawLines(text: string) {
        if (!text) return;
        const safeText = redactSecrets(text);
        // Use SSE multi-`data:` field syntax so embedded newlines are preserved
        // in the single reconstructed event.data on the browser side.
        const payload = safeText.split('\n').map(l => `data: ${l}`).join('\n');
        controller.enqueue(encoder.encode(`${payload}\n\n`));
      }

      function sseEncode(data: string, event?: string): string {
        const lines = redactSecrets(data).split('\n').map(line => `data: ${line}`).join('\n');
        return event ? `event: ${event}\n${lines}\n\n` : `${lines}\n\n`;
      }

      // Passthrough mode: non-JSON lines → `raw` SSE events (monospace in terminal),
      // JSON lines → parsed Claude events via parseStreamLines. `done` events from
      // the parser are suppressed — the server emits its own done so the terminal
      // doesn't close prematurely on an embedded child result.
      //
      // parseState / parsedState are shared across calls so tool_use blocks that
      // start on one fs.watch batch and stop on the next still emit.
      // passPending / parsedPending hold an incomplete trailing line at a chunk
      // boundary so it isn't lost between reads.
      const parseState: ParseState = createParseState();
      let passPending = '';
      const parsedState: ParseState = createParseState();
      let parsedPending = '';

      function sendPassthroughContent(text: string) {
        const combined = passPending + text;
        const nl = combined.lastIndexOf('\n');
        if (nl === -1) {
          // No newline at all — the whole thing is incomplete, buffer it
          passPending = combined;
          return;
        }
        const processable = combined.slice(0, nl);
        passPending = combined.slice(nl + 1);

        const events = parseStreamLines(processable, {
          state: parseState,
          onRawLine: (line) => {
            controller.enqueue(encoder.encode(sseEncode(line, 'raw')));
          },
        });
        for (const event of events) {
          if (event.type === 'text') {
            controller.enqueue(encoder.encode(sseEncode(event.text)));
          } else if (event.type === 'thinking') {
            controller.enqueue(encoder.encode(sseEncode(event.text, 'thinking')));
          } else if (event.type === 'tool_use') {
            controller.enqueue(encoder.encode(sseEncode(JSON.stringify({ name: event.name, input: event.input }), 'tool_use')));
          } else if (event.type === 'tool_result') {
            controller.enqueue(encoder.encode(sseEncode(JSON.stringify({ content: event.content }), 'tool_result')));
          } else if (event.type === 'compacting') {
            controller.enqueue(encoder.encode(sseEncode('', 'compacting')));
          }
          // `done` events from parser suppressed — server emits its own for passthrough
        }
      }

      function sendParsedEvents(text: string) {
        // Buffer incomplete trailing lines between reads so a JSON event line
        // that spans two readNewBytes() calls isn't silently dropped.
        const combined = parsedPending + text;
        const nl = combined.lastIndexOf('\n');
        if (nl === -1) {
          parsedPending = combined;
          return;
        }
        const processable = combined.slice(0, nl);
        parsedPending = combined.slice(nl + 1);

        const events = parseStreamLines(processable, { state: parsedState });
        for (const event of events) {
          if (event.type === 'text') {
            controller.enqueue(encoder.encode(sseEncode(event.text)));
          } else if (event.type === 'thinking') {
            controller.enqueue(encoder.encode(sseEncode(event.text, 'thinking')));
          } else if (event.type === 'tool_use') {
            controller.enqueue(encoder.encode(sseEncode(JSON.stringify({ name: event.name, input: event.input }), 'tool_use')));
          } else if (event.type === 'tool_result') {
            controller.enqueue(encoder.encode(sseEncode(JSON.stringify({ content: event.content }), 'tool_result')));
          } else if (event.type === 'compacting') {
            controller.enqueue(encoder.encode(sseEncode('', 'compacting')));
          } else if (event.type === 'done') {
            const jobForProvider = getJob(jobId);
            const result = jobForProvider?.provider
              ? { ...event.result, provider: jobForProvider.provider }
              : event.result;
            controller.enqueue(
              encoder.encode(sseEncode(JSON.stringify(result), 'done'))
            );
          }
        }
      }

      const sendContent = raw ? sendRawLines : passthrough ? sendPassthroughContent : sendParsedEvents;

      function closeStream(watcher: ReturnType<typeof watch> | null) {
        watcher?.close();
        try { controller.close(); } catch {}
      }

      function extractLogDetail(): string | null {
        try {
          const content = readRedactedFileSync(logPath);
          if (!content.trim()) return 'log file empty — claude CLI exited without writing anything. Common causes: rate-limited (5-hour window), cold-start crash, or auth/session conflict with a concurrent run. Retrying usually works.';
          const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
          // If every non-empty line is a [tamtam] wrapper marker (the launch
          // banner and exit-code tail), claude CLI never actually emitted
          // anything. Surface that as a diagnosable message instead of
          // echoing the launching command as "detail" — that was useless to
          // the user.
          const wrapperOnly = lines.every(l => l.startsWith('[tamtam]'));
          if (wrapperOnly) {
            return 'claude CLI exited immediately without producing any output. Usually one of: (1) invalid --resume session id, (2) rate-limited (5-hour window), (3) auth expired, or (4) a concurrent claude run in the same project holding the session. Try again, or start a new session without --resume.';
          }
          // Match parseStreamLines' prefix stripping — aggregate release logs
          // emit `<ISO-timestamp>: <json>` per line, and without this a JSON.parse
          // of the raw line fails and the entire stream-json payload gets
          // classified as "non-JSON" and surfaced as error detail (red text in
          // the terminal).
          const TS_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?:\s/;
          const nonJson: string[] = [];
          for (const line of lines) {
            if (line.startsWith('[tamtam]')) continue; // drop wrapper chrome from detail
            const tsMatch = line.match(TS_PREFIX_RE);
            const body = tsMatch ? line.slice(tsMatch[0].length) : line;
            try { JSON.parse(body); } catch { nonJson.push(line); }
          }
          if (nonJson.length > 0) return nonJson.slice(-20).join('\n');
          // Only JSON in log, no `"type":"result"` — Claude was streaming tokens then died mid-response
          const hasAnyStream = content.includes('"stream_event"');
          if (hasAnyStream) {
            return 'claude streamed partial output but never emitted a final result — likely killed/crashed mid-response';
          }
          return 'claude wrote JSON to log but never emitted a final result line';
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'log file missing';
          return `could not read log: ${errMsg(e)}`;
        }
      }

      // Flush any incomplete trailing line held in passPending / parsedPending so
      // the final line of a log isn't swallowed at stream end.
      function flushPassthroughPending() {
        if (!passthrough || !passPending) return;
        const tail = passPending;
        passPending = '';
        sendPassthroughContent(tail + '\n');
      }

      function flushParsedPending() {
        if (raw || passthrough || !parsedPending) return;
        const tail = parsedPending;
        parsedPending = '';
        sendParsedEvents(tail + '\n');
      }

      function emitDone(watcher: ReturnType<typeof watch> | null, exitCode?: number | null) {
        flushPassthroughPending();
        flushParsedPending();
        try {
          const payload: Record<string, unknown> = { exitCode: exitCode ?? null };
          // passthrough jobs already streamed all log content — skip detail to avoid duplicating it as red error text
          if (!passthrough && (exitCode ?? 0) !== 0) {
            const detail = extractLogDetail();
            if (detail) payload.detail = detail;
          }
          // Carry the originating provider so the client can pin follow-up
          // turns to the same CLI — session IDs are not portable across
          // providers (codex's "rollout" store ≠ claude's session store).
          const jobForProvider = getJob(jobId);
          if (jobForProvider?.provider) payload.provider = jobForProvider.provider;
          controller.enqueue(encoder.encode(sseEncode(JSON.stringify(payload), 'done')));
        } catch {}
        closeStream(watcher);
      }

      // Track whether we've seen a "type":"result" line so we don't re-scan
      // the full file on every poll once the job finishes.
      let seenResult = false;

      function hasResultLine(text: string): boolean {
        return text.includes('"type":"result"');
      }

      // Read new bytes from offset using an open fd — avoids re-reading the
      // whole file on every fs.watch tick (critical for large logs). Skips
      // the existsSync precheck: openSync throws ENOENT if the file is gone,
      // and the catch handles it the same way an existence check would.
      function readNewBytes(): string {
        let fd = -1;
        try {
          fd = openSync(/*turbopackIgnore: true*/ logPath, 'r');
          const size = fstatSync(fd).size;
          if (size <= offset) return '';
          const len = size - offset;
          const buf = Buffer.allocUnsafe(len);
          const bytesRead = readSync(fd, buf, 0, len, offset);
          offset += bytesRead;
          return buf.subarray(0, bytesRead).toString('utf-8');
        } catch {
          return '';
        } finally {
          if (fd >= 0) try { closeSync(fd); } catch {}
        }
      }

      // Replay existing content. Skip the existsSync precheck — let
      // readFileSync throw ENOENT, the catch handles it identically.
      try {
        const content = readFileSync(/*turbopackIgnore: true*/ logPath, 'utf-8');
        offset = Buffer.byteLength(content);
        sendContent(content);
        if (hasResultLine(content)) seenResult = true;
      } catch { /* missing or unreadable — nothing to replay */ }

      // If job is already finished, close immediately (non-Claude jobs have no NDJSON done event)
      const jobRecord = getJob(jobId);
      if (!raw && !passthrough && seenResult) {
        try { controller.close(); } catch {}
        return;
      }
      if (jobRecord?.finishedAt) {
        if (raw || passthrough) {
          // raw: no NDJSON done; passthrough: suppresses result events — always emit synthetic done
          emitDone(null, jobRecord.exitCode);
        } else {
          // Only emit synthetic done if parseStreamLines didn't already produce one
          if (!seenResult) {
            emitDone(null, jobRecord.exitCode);
          } else {
            try { controller.close(); } catch {}
          }
        }
        return;
      }

      // If log file doesn't exist, there's nothing to watch (fs.watch would throw).
      if (!existsSync(/*turbopackIgnore: true*/ logPath)) {
        try { controller.close(); } catch {}
        return;
      }

      // Watch for new content
      let watcher: ReturnType<typeof watch> | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let closed = false;

      function cleanup() {
        if (closed) return;
        closed = true;
        watcher?.close();
        if (pollTimer) clearInterval(pollTimer);
        try { controller.close(); } catch {}
      }

      function checkFinished(): boolean {
        try {
          const newContent = readNewBytes();
          if (newContent) {
            sendContent(newContent);
            if (!seenResult && hasResultLine(newContent)) seenResult = true;
            if (!raw && !passthrough && seenResult) {
              cleanup();
              return true;
            }
          }
          const job = getJob(jobId);
          if (!job?.finishedAt) return false;
          if (raw || passthrough) {
            emitDoneAndCleanup(job.exitCode);
          } else {
            if (!seenResult) {
              // One final check in case result landed in a batch we haven't seen
              const tail = readNewBytes();
              if (tail) { sendContent(tail); if (tail.includes('"type":"result"')) seenResult = true; }
            }
            if (!seenResult) {
              emitDoneAndCleanup(job.exitCode);
            } else {
              cleanup();
            }
          }
          return true;
        } catch {
          return false;
        }
      }

      function emitDoneAndCleanup(exitCode?: number | null) {
        flushPassthroughPending();
        flushParsedPending();
        try {
          const payload: Record<string, unknown> = { exitCode: exitCode ?? null };
          // passthrough jobs already streamed all log content — skip detail to avoid duplicating it as red error text
          if (!passthrough && (exitCode ?? 0) !== 0) {
            const detail = extractLogDetail();
            if (detail) payload.detail = detail;
          }
          const jobForProvider = getJob(jobId);
          if (jobForProvider?.provider) payload.provider = jobForProvider.provider;
          controller.enqueue(encoder.encode(sseEncode(JSON.stringify(payload), 'done')));
        } catch {}
        cleanup();
      }

      try {
        watcher = watch(/*turbopackIgnore: true*/ logPath, () => { checkFinished(); });
      } catch {}

      // Poll every STREAM_POLL_MS as a safety net — fs.watch can miss the finishedAt
      // transition if the last log write happens before the job's exit handler runs.
      // Probe process status less often (every ~5s of wall time, i.e. every
      // ceil(5000 / STREAM_POLL_MS) ticks).
      const PROBE_EVERY_TICKS = Math.max(1, Math.ceil(5000 / STREAM_POLL_MS));
      let tick = 0;
      pollTimer = setInterval(() => {
        tick++;
        if (tick % PROBE_EVERY_TICKS === 0) {
          const jobForProbe = getJob(jobId);
          if (jobForProbe && !jobForProbe.finishedAt) {
            probeJobStatus(jobForProbe).catch(() => {});
          }
        }
        checkFinished();
      }, STREAM_POLL_MS);

      // Clean up on abort
      request.signal.addEventListener('abort', () => { cleanup(); });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
