import { NextRequest, NextResponse } from 'next/server';
import { readdirSync, type Dirent } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { loadFileConfigWithSource } from '@/lib/skills/tamtam-file-config';

type ProjectDoc = { name: string; path: string; content: string };

const README_CANDIDATES = ['README.md', 'readme.md', 'Readme.md'];

async function readRootReadme(projPath: string): Promise<ProjectDoc | null> {
  const reads = README_CANDIDATES.map(async (candidate) => {
    const p = join(/*turbopackIgnore: true*/ projPath, candidate);
    try {
      const content = await readFile(/*turbopackIgnore: true*/ p, 'utf-8');
      return { name: 'README.md', path: candidate, content };
    } catch {
      return null;
    }
  });
  const results = await Promise.all(reads);
  return results.find((doc): doc is ProjectDoc => doc !== null) ?? null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return NextResponse.json({ detail: 'project not found' }, { status: 404 });
  }

  const docs: ProjectDoc[] = [];

  const rootReadme = await readRootReadme(projPath);
  if (rootReadme) {
    docs.push(rootReadme);
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
  docs.push(...docResults.filter((doc): doc is ProjectDoc => doc !== null));

  if (rootReadme) {
    const rest = docs.splice(1).sort((a, b) => a.name.localeCompare(b.name));
    docs.push(...rest);
  } else {
    docs.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Cross-reference each doc against the project's .tamtam auto-attach rules so
  // the Docs tab can show which docs an agent will actually see (and on which
  // keywords) — the tab's reason to exist. Best-effort; never fails the list.
  let attachRules: { doc: string; keywords: string[] }[] = [];
  try {
    attachRules = loadFileConfigWithSource(projPath).config?.auto_attach_docs ?? [];
  } catch {
    attachRules = [];
  }
  const keywordsForDoc = (doc: ProjectDoc): string[] => {
    const kws = new Set<string>();
    for (const rule of attachRules) {
      if (!rule || typeof rule.doc !== 'string' || !Array.isArray(rule.keywords)) continue;
      const target = rule.doc.replace(/^\.?\//, '');
      if (target === doc.path || target === doc.name || doc.path.endsWith(target)) {
        for (const k of rule.keywords) if (typeof k === 'string') kws.add(k);
      }
    }
    return [...kws];
  };

  return NextResponse.json({
    docs: docs.map((d) => ({ ...d, autoAttachKeywords: keywordsForDoc(d) })),
  });
}
