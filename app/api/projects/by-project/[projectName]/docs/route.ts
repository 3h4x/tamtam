import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath } from '@/lib/project-data';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return NextResponse.json({ detail: 'project not found' }, { status: 404 });
  }

  const docsDir = join(projPath, 'docs');
  if (!existsSync(docsDir)) {
    return NextResponse.json({ docs: [] });
  }

  const docs: { name: string; content: string }[] = [];
  for (const entry of readdirSync(docsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    try {
      const content = readFileSync(join(docsDir, entry.name), 'utf-8');
      docs.push({ name: entry.name, content });
    } catch {}
  }

  docs.sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ docs });
}
