import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath } from '@/lib/shared/project-data';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return NextResponse.json({ detail: 'project not found' }, { status: 404 });
  }

  const docs: { name: string; path: string; content: string }[] = [];

  // README at project root
  for (const candidate of ['README.md', 'readme.md', 'Readme.md']) {
    const p = join(/*turbopackIgnore: true*/ projPath, candidate);
    if (existsSync(/*turbopackIgnore: true*/ p)) {
      try {
        docs.push({ name: 'README.md', path: candidate, content: readFileSync(/*turbopackIgnore: true*/ p, 'utf-8') });
      } catch {}
      break;
    }
  }

  // docs/ directory
  const docsDir = join(/*turbopackIgnore: true*/ projPath, 'docs');
  if (existsSync(docsDir)) {
    for (const entry of readdirSync(/*turbopackIgnore: true*/ docsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      try {
        const content = readFileSync(join(/*turbopackIgnore: true*/ docsDir, entry.name), 'utf-8');
        docs.push({ name: entry.name, path: `docs/${entry.name}`, content });
      } catch {}
    }
    const rest = docs.splice(1).sort((a, b) => a.name.localeCompare(b.name));
    docs.push(...rest);
  }

  return NextResponse.json({ docs });
}
