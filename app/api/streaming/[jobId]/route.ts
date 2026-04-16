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

      function sendParsedEvents(text: string) {
        const events = parseStreamLines(text);
        for (const event of events) {
          if (event.type === 'text') {
            controller.enqueue(encoder.encode(`data: ${event.text}\n\n`));
          } else if (event.type === 'thinking') {
            controller.enqueue(encoder.encode(`event: thinking\ndata: ${event.text}\n\n`));
          } else if (event.type === 'tool_use') {
            controller.enqueue(encoder.encode(`data: \n\n> Tool: ${event.name}\n\n`));
          } else if (event.type === 'tool_result') {
            const truncated = event.content.length > 500
              ? event.content.slice(0, 500) + '...'
              : event.content;
            controller.enqueue(encoder.encode(`data: ${truncated}\n\n`));
          } else if (event.type === 'done') {
            controller.enqueue(
              encoder.encode(`event: done\ndata: ${JSON.stringify(event.result)}\n\n`)
            );
          }
        }
      }

      const sendContent = raw ? sendRawLines : sendParsedEvents;

      // Replay existing content
      if (existsSync(logPath)) {
        try {
          const content = readFileSync(logPath, 'utf-8');
          offset = Buffer.byteLength(content);
          sendContent(content);
        } catch {}
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
