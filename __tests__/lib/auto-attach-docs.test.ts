import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('@/lib/git/git-branch', () => ({
  getBranchContext: vi.fn(() => ({
    currentBranch: 'main',
    defaultBranch: 'main',
    isDefaultBranch: true,
  })),
  gitShowSync: vi.fn(() => null),
}));

import * as gitBranch from '@/lib/git/git-branch';
import {
  resolveAutoAttachedDocs,
  formatAutoAttachedDocsBlock,
} from '@/lib/skills/auto-attach-docs';
import type { FileProjectConfig } from '@/lib/skills/tamtam-file-config';

let projectPath: string;

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), 'auto-attach-docs-'));
  mkdirSync(join(projectPath, 'docs'), { recursive: true });
  writeFileSync(join(projectPath, 'docs', 'TEST.md'), '# Testing\nUse vitest.\n');
  writeFileSync(join(projectPath, 'docs', 'PIPELINE.md'), '# Pipeline\nRelease flow.\n');
  vi.mocked(gitBranch.getBranchContext).mockReturnValue({
    currentBranch: 'main',
    defaultBranch: 'main',
    isDefaultBranch: true,
  });
  vi.mocked(gitBranch.gitShowSync).mockReturnValue(null);
});

afterEach(() => {
  rmSync(projectPath, { recursive: true, force: true });
});

function cfg(rules: Array<{ keywords: string[]; doc: string }>): FileProjectConfig {
  return { auto_attach_docs: rules };
}

describe('resolveAutoAttachedDocs', () => {
  it('matches a keyword with word boundary', () => {
    const result = resolveAutoAttachedDocs(
      projectPath,
      'please fix the test',
      cfg([{ keywords: ['test'], doc: 'docs/TEST.md' }]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('TEST.md');
    expect(result[0].matchedKeyword).toBe('test');
    expect(result[0].content).toContain('vitest');
  });

  it('is case-insensitive', () => {
    const result = resolveAutoAttachedDocs(
      projectPath,
      'FIX THE TEST',
      cfg([{ keywords: ['test'], doc: 'docs/TEST.md' }]),
    );
    expect(result).toHaveLength(1);
  });

  it('does not match substrings inside other words', () => {
    const result = resolveAutoAttachedDocs(
      projectPath,
      'testing the waters',
      cfg([{ keywords: ['test'], doc: 'docs/TEST.md' }]),
    );
    expect(result).toHaveLength(0);
  });

  it('handles plural keywords explicitly', () => {
    const result = resolveAutoAttachedDocs(
      projectPath,
      'fix the tests',
      cfg([{ keywords: ['test', 'tests'], doc: 'docs/TEST.md' }]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].matchedKeyword).toBe('tests');
  });

  it('returns empty when no rules match', () => {
    const result = resolveAutoAttachedDocs(
      projectPath,
      'do something unrelated',
      cfg([{ keywords: ['test'], doc: 'docs/TEST.md' }]),
    );
    expect(result).toEqual([]);
  });

  it('returns empty when config is null', () => {
    expect(resolveAutoAttachedDocs(projectPath, 'fix the test', null)).toEqual([]);
  });

  it('returns empty when config has no rules', () => {
    expect(resolveAutoAttachedDocs(projectPath, 'fix the test', {})).toEqual([]);
  });

  it('returns empty for blank prompt', () => {
    expect(
      resolveAutoAttachedDocs(projectPath, '   ', cfg([{ keywords: ['test'], doc: 'docs/TEST.md' }])),
    ).toEqual([]);
  });

  it('skips missing doc files silently', () => {
    const result = resolveAutoAttachedDocs(
      projectPath,
      'fix the test',
      cfg([{ keywords: ['test'], doc: 'docs/MISSING.md' }]),
    );
    expect(result).toEqual([]);
  });

  it('dedupes by absolute doc path', () => {
    const result = resolveAutoAttachedDocs(
      projectPath,
      'fix the test, run the tests',
      cfg([
        { keywords: ['test'], doc: 'docs/TEST.md' },
        { keywords: ['tests'], doc: 'docs/TEST.md' },
      ]),
    );
    expect(result).toHaveLength(1);
  });

  it('returns multiple distinct docs when multiple rules match', () => {
    const result = resolveAutoAttachedDocs(
      projectPath,
      'fix test then deploy',
      cfg([
        { keywords: ['test'], doc: 'docs/TEST.md' },
        { keywords: ['deploy'], doc: 'docs/PIPELINE.md' },
      ]),
    );
    expect(result.map((d) => d.name).sort()).toEqual(['PIPELINE.md', 'TEST.md']);
  });

  it('rejects absolute doc paths', () => {
    const result = resolveAutoAttachedDocs(
      projectPath,
      'fix the test',
      cfg([{ keywords: ['test'], doc: '/etc/passwd' }]),
    );
    expect(result).toEqual([]);
  });

  it('rejects parent-traversal doc paths', () => {
    const result = resolveAutoAttachedDocs(
      projectPath,
      'fix the test',
      cfg([{ keywords: ['test'], doc: '../../etc/passwd' }]),
    );
    expect(result).toEqual([]);
  });

  it('accepts in-project doc filenames that start with two dots', () => {
    writeFileSync(join(projectPath, 'docs', '..TEST.md'), '# Dotfile-like doc\n');
    const result = resolveAutoAttachedDocs(
      projectPath,
      'fix the test',
      cfg([{ keywords: ['test'], doc: 'docs/..TEST.md' }]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('..TEST.md');
    expect(result[0].content).toContain('Dotfile-like doc');
  });

  it('rejects default-branch docs that resolve outside via an in-project symlink directory', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'auto-attach-docs-outside-'));
    writeFileSync(join(outsideDir, 'SECRET.md'), '# Secret\nDo not attach.\n');
    symlinkSync(outsideDir, join(projectPath, 'docs', 'external'), 'dir');

    try {
      const result = resolveAutoAttachedDocs(
        projectPath,
        'fix the test',
        cfg([{ keywords: ['test'], doc: 'docs/external/SECRET.md' }]),
      );
      expect(result).toEqual([]);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  describe('non-default branch trust boundary', () => {
    beforeEach(() => {
      vi.mocked(gitBranch.getBranchContext).mockReturnValue({
        currentBranch: 'feature/x',
        defaultBranch: 'main',
        isDefaultBranch: false,
      });
    });

    it('reads doc content from trusted ref, not working tree', () => {
      // Working-tree content is malicious; trusted ref returns safe content.
      writeFileSync(join(projectPath, 'docs', 'TEST.md'), 'MALICIOUS WORKING TREE');
      vi.mocked(gitBranch.gitShowSync).mockReturnValue('SAFE TRUSTED CONTENT');

      const result = resolveAutoAttachedDocs(
        projectPath,
        'fix the test',
        cfg([{ keywords: ['test'], doc: 'docs/TEST.md' }]),
      );
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('SAFE TRUSTED CONTENT');
      expect(result[0].content).not.toContain('MALICIOUS');
      expect(vi.mocked(gitBranch.gitShowSync)).toHaveBeenCalledWith(
        projectPath,
        'origin/main',
        'docs/TEST.md',
      );
    });

    it('skips doc when trusted ref does not have it', () => {
      writeFileSync(join(projectPath, 'docs', 'TEST.md'), 'working tree only');
      vi.mocked(gitBranch.gitShowSync).mockReturnValue(null);

      const result = resolveAutoAttachedDocs(
        projectPath,
        'fix the test',
        cfg([{ keywords: ['test'], doc: 'docs/TEST.md' }]),
      );
      expect(result).toEqual([]);
    });
  });
});

describe('formatAutoAttachedDocsBlock', () => {
  it('returns null for empty list', () => {
    expect(formatAutoAttachedDocsBlock([])).toBeNull();
  });

  it('formats a block with doc name and content', () => {
    const block = formatAutoAttachedDocsBlock([
      {
        rulePath: 'docs/TEST.md',
        absolutePath: '/abs/docs/TEST.md',
        name: 'TEST.md',
        content: 'body',
        matchedKeyword: 'test',
      },
    ]);
    expect(block).toContain('## Auto-attached docs');
    expect(block).toContain('## TEST.md');
    expect(block).toContain('body');
  });
});
