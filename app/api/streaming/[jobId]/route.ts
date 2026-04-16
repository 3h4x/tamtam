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
        for (const line of text.split('\n')) {
          if (line.trim()) {
            controller.enqueue(encoder.encode(`data: ${line}\n\n`));
          }
        }
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
            controller.enqueue(encoder.encode(sseEncode(`\n> Tool: ${event.name}\n`)));
          } else if (event.type === 'tool_result') {
            const truncated = event.content.length > 500
              ? event.content.slice(0, 500) + '...'
              : event.content;
            controller.enqueue(encoder.encode(sseEncode(truncated)));
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

      function emitDone(watcher: ReturnType<typeof watch> | null, exitCode?: number | null) {
        try {
          controller.enqueue(encoder.encode(sseEncode(JSON.stringify({ exitCode: exitCode ?? null }), 'done')));
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

      // Watch for new content
      let watcher: ReturnType<typeof watch> | null = null;
      try {
        watcher = watch(logPath, () => {
          try {
            const content = readFileSync(logPath, 'utf-8');
            const currentSize = Buffer.byteLength(content);
            if (currentSize > offset) {
              const newContent = Buffer.from(content).slice(offset).toString('utf-8');
              offset = currentSize;
              sendContent(newContent);
            }
            // Job finished — emit done and close
            const job = getJob(jobId);
            if (job?.finishedAt) {
              if (raw) {
                emitDone(watcher, job.exitCode);
              } else {
                const fullContent = readFileSync(logPath, 'utf-8');
                if (!fullContent.includes('"type":"result"')) {
                  emitDone(watcher, job.exitCode);
                } else {
                  closeStream(watcher);
                }
              }
            }
          } catch {}
        });
      } catch {}

      // Clean up on abort
      request.signal.addEventListener('abort', () => {
        watcher?.close();
        try { controller.close(); } catch {}
      });
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
