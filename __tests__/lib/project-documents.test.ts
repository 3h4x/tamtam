import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listProjectDocuments } from '@/lib/shared/project-documents';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'tamtam-proj-docs-'));
}

function touch(dir: string, rel: string, content = '# md'): string {
  const full = join(dir, rel);
  mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(full, content);
  return full;
}

describe('listProjectDocuments', () => {
  let root: string;

  beforeEach(() => {
    root = tmp();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns empty array when project has no tracked docs', () => {
    expect(listProjectDocuments(root)).toEqual([]);
  });

  it('includes CLAUDE.md when it exists at root', () => {
    touch(root, 'CLAUDE.md');
    const result = listProjectDocuments(root);
    expect(result).toContain(join(root, 'CLAUDE.md'));
  });

  it('includes README.md when it exists at root', () => {
    touch(root, 'README.md');
    const result = listProjectDocuments(root);
    expect(result).toContain(join(root, 'README.md'));
  });

  it('includes markdown files from docs/ directory', () => {
    touch(root, 'docs/API.md');
    touch(root, 'docs/SETUP.md');
    const result = listProjectDocuments(root);
    expect(result).toContain(join(root, 'docs/API.md'));
    expect(result).toContain(join(root, 'docs/SETUP.md'));
  });

  it('walks docs/ subdirectories recursively', () => {
    touch(root, 'docs/sub/deep.md');
    const result = listProjectDocuments(root);
    expect(result).toContain(join(root, 'docs/sub/deep.md'));
  });

  it('excludes non-.md files from docs/', () => {
    touch(root, 'docs/script.sh');
    const result = listProjectDocuments(root);
    expect(result.some(p => p.endsWith('script.sh'))).toBe(false);
  });

  it('includes .tamtam/agents/ markdown files by default', () => {
    touch(root, '.tamtam/agents/qa.md');
    const result = listProjectDocuments(root);
    expect(result).toContain(join(root, '.tamtam/agents/qa.md'));
  });

  it('excludes .tamtam/agents/ files when includeAgentDocs is false', () => {
    touch(root, '.tamtam/agents/qa.md');
    const result = listProjectDocuments(root, { includeAgentDocs: false });
    expect(result.some(p => p.includes('.tamtam'))).toBe(false);
  });

  it('returns paths sorted by posix-relative order', () => {
    touch(root, 'README.md');
    touch(root, 'CLAUDE.md');
    touch(root, 'docs/Z.md');
    touch(root, 'docs/A.md');
    const result = listProjectDocuments(root, { includeAgentDocs: false });
    const relatives = result.map(p => p.slice(root.length + 1).replace(/\\/g, '/'));
    expect(relatives).toEqual([...relatives].sort((a, b) => a.localeCompare(b)));
  });

  it('handles missing docs/ directory without throwing', () => {
    expect(() => listProjectDocuments(root)).not.toThrow();
  });

  it('handles missing .tamtam/agents/ directory without throwing', () => {
    expect(() => listProjectDocuments(root, { includeAgentDocs: true })).not.toThrow();
  });

  it('does not include root-level .md files other than CLAUDE.md and README.md', () => {
    touch(root, 'RANDOM.md');
    const result = listProjectDocuments(root);
    expect(result.some(p => p.endsWith('RANDOM.md'))).toBe(false);
  });
});
