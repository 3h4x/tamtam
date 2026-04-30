import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getImproveConfig } from '@/lib/scheduling/scheduling';

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
        const buf = Buffer.alloc(50_000);
        const fd = require('fs').openSync(filepath, 'r');
        require('fs').readSync(fd, buf, 0, 50_000, size - 50_000);
        require('fs').closeSync(fd);
        content = buf.toString('utf-8');
        const nl = content.indexOf('\n');
        if (nl >= 0) content = content.slice(nl + 1);
      } else {
        content = readFileSync(filepath, 'utf-8');
      }
      logs.push({ filename: f, content });
    } catch {
      continue;
    }
  }

  return NextResponse.json({ logs });
}
