import { readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const MARKDOWN_EXT = '.md';
const DOCS_DIR = 'docs';
const AGENTS_DIR = join('.tamtam', 'agents');
const ROOT_DOCS = new Set(['CLAUDE.md', 'README.md']);

function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

function walkMarkdownFiles(root: string, dir: string): string[] {
  const base = join(/*turbopackIgnore: true*/ root, dir);
  try {
    const entries = readdirSync(/*turbopackIgnore: true*/ base, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = join(/*turbopackIgnore: true*/ base, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkMarkdownFiles(root, join(dir, entry.name)));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(MARKDOWN_EXT)) {
        files.push(fullPath);
      }
    }
    return files;
  } catch {
    return [];
  }
}

export function listProjectDocuments(projectPath: string): string[] {
  const files = new Set<string>();

  for (const fileName of ROOT_DOCS) {
    const fullPath = join(/*turbopackIgnore: true*/ projectPath, fileName);
    try {
      if (statSync(/*turbopackIgnore: true*/ fullPath).isFile()) {
        files.add(fullPath);
      }
    } catch {}
  }

  for (const filePath of walkMarkdownFiles(projectPath, DOCS_DIR)) {
    files.add(filePath);
  }

  for (const filePath of walkMarkdownFiles(projectPath, AGENTS_DIR)) {
    files.add(filePath);
  }

  return Array.from(files).sort((a, b) =>
    toPosixPath(relative(projectPath, a)).localeCompare(toPosixPath(relative(projectPath, b)))
  );
}
