import { describe, expect, it } from 'vitest';

import {
  isCommittedTamtamMetadataPath,
  isTamtamPath,
  reviewablePathsFromStatus,
  statusHasAnyPath,
  statusHasNonTamtamPath,
  statusHasOnlyCommittedTamtamMetadataPaths,
  statusPath,
  statusPaths,
} from '@/lib/pipeline/review-scope';

describe('review-scope helpers', () => {
  it('extracts the destination path from porcelain rename lines', () => {
    expect(statusPath('R  src/old-name.ts -> src/new-name.ts')).toBe('src/new-name.ts');
    expect(statusPath(' M src/current.ts')).toBe('src/current.ts');
  });

  it('extracts every path from porcelain rename lines when source ownership matters', () => {
    expect(statusPaths('R  src/old-name.ts -> .tamtam/agents/new-name.md')).toEqual([
      'src/old-name.ts',
      '.tamtam/agents/new-name.md',
    ]);
    expect(statusPaths(' M .tamtam/config.yml')).toEqual(['.tamtam/config.yml']);
  });

  it('treats only the .tamtam root and its descendants as tamtam-managed paths', () => {
    expect(isTamtamPath('.tamtam')).toBe(true);
    expect(isTamtamPath('.tamtam/config.yml')).toBe(true);
    expect(isTamtamPath('.tamtam-extra/config.yml')).toBe(false);
    expect(isTamtamPath('src/.tamtam/config.yml')).toBe(false);
  });

  it('recognizes only committed TamTam metadata as release-bypass safe', () => {
    expect(isCommittedTamtamMetadataPath('.tamtam/config.yml')).toBe(true);
    expect(isCommittedTamtamMetadataPath('.tamtam/agents/review.md')).toBe(true);
    expect(isCommittedTamtamMetadataPath('.tamtam/.gitignore')).toBe(true);
    expect(isCommittedTamtamMetadataPath('.tamtam/cache/agent-memory/review.md')).toBe(false);
    expect(isCommittedTamtamMetadataPath('.tamtam/logo.svg')).toBe(false);
  });

  it('ignores blank porcelain output when checking whether any paths are present', () => {
    expect(statusHasAnyPath('')).toBe(false);
    expect(statusHasAnyPath('\n  \n')).toBe(false);
    expect(statusHasAnyPath('?? src/new-file.ts\n')).toBe(true);
  });

  it('filters .tamtam-only changes when deciding whether reviewable work exists', () => {
    const tamtamOnly = [
      ' M .tamtam/config.yml',
      'R  docs/review.md -> .tamtam/agents/review.md',
      '?? .tamtam/agents/new-agent.md',
    ].join('\n');
    const mixed = `${tamtamOnly}\n M src/index.ts`;

    expect(statusHasNonTamtamPath(tamtamOnly)).toBe(false);
    expect(statusHasNonTamtamPath(mixed)).toBe(true);
  });

  it('requires every status path to be committed TamTam metadata for release bypass', () => {
    expect(statusHasOnlyCommittedTamtamMetadataPaths([
      ' M .tamtam/config.yml',
      'R  .tamtam/agents/old.md -> .tamtam/agents/new.md',
      '?? .tamtam/.gitignore',
    ].join('\n'))).toBe(true);
    expect(statusHasOnlyCommittedTamtamMetadataPaths(' M .tamtam/cache/audits/improve.md')).toBe(false);
    expect(statusHasOnlyCommittedTamtamMetadataPaths([
      ' M .tamtam/config.yml',
      ' M .tamtam/cache/agent-memory/review.md',
    ].join('\n'))).toBe(false);
    expect(statusHasOnlyCommittedTamtamMetadataPaths('R  src/app.ts -> .tamtam/agents/app.md')).toBe(false);
  });

  it('returns deduped non-.tamtam reviewable paths using rename destinations', () => {
    const status = [
      'R  src/old-name.ts -> src/new-name.ts',
      ' M .tamtam/config.yml',
      '?? src/new-name.ts',
      'A  src/added.ts',
      'R  .tamtam/old.md -> .tamtam/new.md',
      ' M src/added.ts',
    ].join('\n');

    expect(reviewablePathsFromStatus(status)).toEqual([
      'src/new-name.ts',
      'src/added.ts',
    ]);
  });
});
