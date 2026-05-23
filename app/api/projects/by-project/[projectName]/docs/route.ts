import { NextRequest, NextResponse } from 'next/server';
import { readdirSync, type Dirent } from 'fs';
import { readFile } from 'fs/promises';
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
  let hasRootReadme = false;

  // README at project root — try each case variant; first success wins.
  for (const candidate of ['README.md', 'readme.md', 'Readme.md']) {
    const p = join(/*turbopackIgnore: true*/ projPath, candidate);
    try {
      const content = await readFile(/*turbopackIgnore: true*/ p, 'utf-8');
      docs.push({ name: 'README.md', path: candidate, content });
      hasRootReadme = true;
      break;
    } catch {
      // try next candidate
    }
  }

  // docs/ directory
  const docsDir = join(/*turbopackIgnore: true*/ projPath, 'docs');
  let docsEntries: Dirent[] = [];
  try {
    docsEntries = readdirSync(/*turbopackIgnore: true*/ docsDir, { withFileTypes: true });
  } catch {
    // no docs/ directory — fall through with empty list
  }
  const docReads = docsEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map(async (entry) => {
      try {
        const content = await readFile(join(/*turbopackIgnore: true*/ docsDir, entry.name), 'utf-8');
        return { name: entry.name, path: `docs/${entry.name}`, content };
      } catch {
        return null;
      }
    });
  const docResults = await Promise.all(docReads);
  docs.push(...docResults.filter((doc): doc is { name: string; path: string; content: string } => doc !== null));

  if (hasRootReadme) {
    const rest = docs.splice(1).sort((a, b) => a.name.localeCompare(b.name));
    docs.push(...rest);
  } else {
    docs.sort((a, b) => a.name.localeCompare(b.name));
  }

  return NextResponse.json({ docs });
}
