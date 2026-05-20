import { describe, expect, it } from 'vitest';

import {
  isTamtamPath,
  reviewablePathsFromStatus,
  statusHasAnyPath,
  statusHasNonTamtamPath,
  statusPath,
} from '@/lib/pipeline/review-scope';

describe('review-scope helpers', () => {
  it('extracts the destination path from porcelain rename lines', () => {
    expect(statusPath('R  src/old-name.ts -> src/new-name.ts')).toBe('src/new-name.ts');
    expect(statusPath(' M src/current.ts')).toBe('src/current.ts');
  });

  it('treats only the .tamtam root and its descendants as tamtam-managed paths', () => {
    expect(isTamtamPath('.tamtam')).toBe(true);
    expect(isTamtamPath('.tamtam/config.yml')).toBe(true);
    expect(isTamtamPath('.tamtam-extra/config.yml')).toBe(false);
    expect(isTamtamPath('src/.tamtam/config.yml')).toBe(false);
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
