import { readdirSync, lstatSync } from 'fs';
import { join, relative, sep } from 'path';

const MARKDOWN_EXT = '.md';
const DOCS_DIR = 'docs';
const AGENTS_DIR = join('.tamtam', 'agents');
const ROOT_DOCS = new Set(['CLAUDE.md', 'README.md']);

export interface ListProjectDocumentsOptions {
  includeAgentDocs?: boolean;
}

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

export function listProjectDocuments(
  projectPath: string,
  opts: ListProjectDocumentsOptions = {}
): string[] {
  const files = new Set<string>();
  const includeAgentDocs = opts.includeAgentDocs ?? true;

  for (const fileName of ROOT_DOCS) {
    const fullPath = join(/*turbopackIgnore: true*/ projectPath, fileName);
    try {
      // `lstatSync` does NOT follow symlinks. The docs walk further down
      // already uses `Dirent.isFile()` (returns false for symlinks), so
      // checking ROOT_DOCS the same way keeps the two entry-points
      // consistent and prevents an accidental symlink at one of the
      // well-known root-doc paths from feeding the symlink target into
      // retrieval indexing / docs picker.
      if (lstatSync(/*turbopackIgnore: true*/ fullPath).isFile()) {
        files.add(fullPath);
      }
    } catch {}
  }

  for (const filePath of walkMarkdownFiles(projectPath, DOCS_DIR)) {
    files.add(filePath);
  }

  if (includeAgentDocs) {
    for (const filePath of walkMarkdownFiles(projectPath, AGENTS_DIR)) {
      files.add(filePath);
    }
  }

  return Array.from(files)
    .map((filePath) => ({
      filePath,
      sortKey: toPosixPath(relative(projectPath, filePath)),
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(({ filePath }) => filePath);
}
