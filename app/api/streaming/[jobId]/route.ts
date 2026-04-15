import { NextRequest } from 'next/server';
import { existsSync, readFileSync, watch } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getJob } from '@/lib/job-storage';

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

  const stream = new ReadableStream({
    start(controller) {
      let offset = 0;

      // Replay existing content
      if (existsSync(logPath)) {
        try {
          const content = readFileSync(logPath, 'utf-8');
          offset = Buffer.byteLength(content);
          for (const line of content.split('\n')) {
            if (line.trim()) {
              controller.enqueue(encoder.encode(`data: ${line}\n\n`));
            }
          }
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
              for (const line of newContent.split('\n')) {
                if (line.trim()) {
                  controller.enqueue(encoder.encode(`data: ${line}\n\n`));
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
