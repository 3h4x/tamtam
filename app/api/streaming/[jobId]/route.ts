import { NextRequest } from 'next/server';
import { existsSync, readFileSync, watch } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getJob } from '@/lib/job-storage';
import { parseStreamLines } from '@/lib/claude-stream-parser';

function getLogPath(jobId: string): string {
  const job = getJob(jobId);
  if (job?.logPath) return job.logPath;
  return join(homedir(), '.z', 'jobs', `${jobId}.log`);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const logPath = getLogPath(jobId);
  const encoder = new TextEncoder();
  const raw = request.nextUrl.searchParams.get('raw') === '1';

  const stream = new ReadableStream({
    start(controller) {
      let offset = 0;

      function sendRawLines(text: string) {
        if (!text) return;
        // Use SSE multi-`data:` field syntax so embedded newlines are preserved
        // in the single reconstructed event.data on the browser side.
        const payload = text.split('\n').map(l => `data: ${l}`).join('\n');
        controller.enqueue(encoder.encode(`${payload}\n\n`));
      }

      function sseEncode(data: string, event?: string): string {
        const lines = data.split('\n').map(line => `data: ${line}`).join('\n');
        return event ? `event: ${event}\n${lines}\n\n` : `${lines}\n\n`;
      }

      function sendParsedEvents(text: string) {
        const events = parseStreamLines(text);
        for (const event of events) {
          if (event.type === 'text') {
            controller.enqueue(encoder.encode(sseEncode(event.text)));
          } else if (event.type === 'thinking') {
            controller.enqueue(encoder.encode(sseEncode(event.text, 'thinking')));
          } else if (event.type === 'tool_use') {
            controller.enqueue(encoder.encode(sseEncode(JSON.stringify({ name: event.name, input: event.input }), 'tool_use')));
          } else if (event.type === 'tool_result') {
            controller.enqueue(encoder.encode(sseEncode(JSON.stringify({ content: event.content }), 'tool_result')));
          } else if (event.type === 'done') {
            controller.enqueue(
              encoder.encode(sseEncode(JSON.stringify(event.result), 'done'))
            );
          }
        }
      }

      const sendContent = raw ? sendRawLines : sendParsedEvents;

      function closeStream(watcher: ReturnType<typeof watch> | null) {
        watcher?.close();
        try { controller.close(); } catch {}
      }

      function extractLogDetail(): string | null {
        try {
          if (!existsSync(logPath)) return 'log file missing';
          const content = readFileSync(logPath, 'utf-8');
          if (!content.trim()) return 'log file empty (claude produced no output)';
          const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
          const nonJson: string[] = [];
          for (const line of lines) {
            try { JSON.parse(line); } catch { nonJson.push(line); }
          }
          if (nonJson.length > 0) return nonJson.slice(-20).join('\n');
          // Only JSON in log, no `"type":"result"` — Claude was streaming tokens then died mid-response
          const hasAnyStream = content.includes('"stream_event"');
          if (hasAnyStream) {
            return 'claude streamed partial output but never emitted a final result — likely killed/crashed mid-response';
          }
          return 'claude wrote JSON to log but never emitted a final result line';
        } catch (e: any) {
          return `could not read log: ${e?.message ?? 'unknown'}`;
        }
      }

      function emitDone(watcher: ReturnType<typeof watch> | null, exitCode?: number | null) {
        try {
          const payload: Record<string, unknown> = { exitCode: exitCode ?? null };
          if ((exitCode ?? 0) !== 0) {
            const detail = extractLogDetail();
            if (detail) payload.detail = detail;
          }
          controller.enqueue(encoder.encode(sseEncode(JSON.stringify(payload), 'done')));
        } catch {}
        closeStream(watcher);
      }

      // Replay existing content
      if (existsSync(logPath)) {
        try {
          const content = readFileSync(logPath, 'utf-8');
          offset = Buffer.byteLength(content);
          sendContent(content);
        } catch {}
      }

      // If job is already finished, close immediately (non-Claude jobs have no NDJSON done event)
      const jobRecord = getJob(jobId);
      if (jobRecord?.finishedAt) {
        if (raw) {
          emitDone(null, jobRecord.exitCode);
        } else {
          // Only emit synthetic done if parseStreamLines didn't already produce one
          const content = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
          if (!content.includes('"type":"result"')) {
            emitDone(null, jobRecord.exitCode);
          } else {
            try { controller.close(); } catch {}
          }
        }
        return;
      }

      // If log file doesn't exist, there's nothing to watch (fs.watch would throw).
      if (!existsSync(logPath)) {
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
          const content = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
          const currentSize = Buffer.byteLength(content);
          if (currentSize > offset) {
            const newContent = Buffer.from(content).slice(offset).toString('utf-8');
            offset = currentSize;
            sendContent(newContent);
          }
          const job = getJob(jobId);
          if (!job?.finishedAt) return false;
          if (raw) {
            emitDoneAndCleanup(job.exitCode);
          } else {
            const fullContent = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
            if (!fullContent.includes('"type":"result"')) {
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
        try {
          const payload: Record<string, unknown> = { exitCode: exitCode ?? null };
          if ((exitCode ?? 0) !== 0) {
            const detail = extractLogDetail();
            if (detail) payload.detail = detail;
          }
          controller.enqueue(encoder.encode(sseEncode(JSON.stringify(payload), 'done')));
        } catch {}
        cleanup();
      }

      try {
        watcher = watch(logPath, () => { checkFinished(); });
      } catch {}

      // Poll every 1s as a safety net — fs.watch can miss the finishedAt
      // transition if the last log write happens before the job's exit handler runs.
      pollTimer = setInterval(() => { checkFinished(); }, 1000);

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
