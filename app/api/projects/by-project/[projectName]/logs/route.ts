import { NextRequest, NextResponse } from 'next/server';
import { readdirSync } from 'fs';
import { join } from 'path';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { readRedactedTail } from '@/lib/jobs/redacted-log-reader';

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

  const logs = (
    await Promise.all(
      files.map(async (f) => {
        const filepath = join(/*turbopackIgnore: true*/ logDir, f);
        try {
          const content = await readRedactedTail(filepath, 50_000);
          return { filename: f, content };
        } catch {
          return null;
        }
      }),
    )
  ).filter((log): log is { filename: string; content: string } => log !== null);

  return NextResponse.json({ logs });
}
