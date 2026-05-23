import { NextRequest, NextResponse } from 'next/server';
import { readdirSync } from 'fs';
import { join } from 'path';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { readRedactedTailSync } from '@/lib/jobs/redacted-log-reader';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const { logDir } = getImproveConfig();

  let files: string[];
  try {
    files = readdirSync(/*turbopackIgnore: true*/ logDir)
      .filter((f) => f.includes(projectName) && f.endsWith('.log'))
      .sort()
      .reverse()
      .slice(0, 5);
  } catch {
    return NextResponse.json({ logs: [] });
  }

  const logs = [];
  for (const f of files) {
    const filepath = join(/*turbopackIgnore: true*/ logDir, f);
    try {
      const content = readRedactedTailSync(filepath, 50_000);
      logs.push({ filename: f, content });
    } catch {
      continue;
    }
  }

  return NextResponse.json({ logs });
}
