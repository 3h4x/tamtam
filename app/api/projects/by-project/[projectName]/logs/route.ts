import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { readRedactedFileSync, readRedactedTailSync } from '@/lib/jobs/redacted-log-reader';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const { logDir } = getImproveConfig();
  if (!existsSync(logDir)) return NextResponse.json({ logs: [] });

  const files = readdirSync(logDir)
    .filter((f) => f.includes(projectName) && f.endsWith('.log'))
    .sort()
    .reverse()
    .slice(0, 5);

  const logs = [];
  for (const f of files) {
    const filepath = join(logDir, f);
    try {
      const size = statSync(filepath).size;
      let content: string;
      if (size > 50_000) {
        content = readRedactedTailSync(filepath, 50_000);
      } else {
        content = readRedactedFileSync(filepath);
      }
      logs.push({ filename: f, content });
    } catch {
      continue;
    }
  }

  return NextResponse.json({ logs });
}
