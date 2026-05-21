import { describe, it, expect } from 'vitest';
import {
  shouldSkipFile,
  buildDiffContext,
  DIFF_MAX_CHARS_PER_FILE,
  DIFF_MAX_TOTAL_CHARS,
} from '@/lib/git/diff-context';

describe('shouldSkipFile', () => {
  it.each([
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'Cargo.lock',
    'composer.lock',
    'Gemfile.lock',
    'poetry.lock',
    'bun.lockb',
    'app.min.js',
    'styles.min.css',
  ])('skips %s', (filename) => {
    expect(shouldSkipFile(filename)).toBe(true);
  });

  it.each([
    'dist/bundle.js',
    'dist/styles.css',
    '.next/server/app.js',
    'build/index.html',
  ])('skips path under dist/build/next: %s', (filename) => {
    expect(shouldSkipFile(filename)).toBe(true);
  });

  it.each([
    'src/index.ts',
    'lib/utils.ts',
    'package.json',
    'README.md',
    'components/Button.tsx',
  ])('does not skip %s', (filename) => {
    expect(shouldSkipFile(filename)).toBe(false);
  });
});

function makeDiffSection(filename: string, content = 'some diff content'): string {
  return `diff --git a/${filename} b/${filename}\nindex abc..def 100644\n--- a/${filename}\n+++ b/${filename}\n${content}\n`;
}

describe('buildDiffContext', () => {
  it('returns empty context when no diff and no stat', () => {
    const result = buildDiffContext('', '');
    expect(result.context).toBe('');
    expect(result.includedFiles).toEqual([]);
    expect(result.skippedFiles).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('includes stat summary when present', () => {
    const result = buildDiffContext('1 file changed, 5 insertions', '');
    expect(result.context).toContain('CHANGES:');
    expect(result.context).toContain('1 file changed, 5 insertions');
  });

  it('includes diff section for normal files', () => {
    const diff = makeDiffSection('src/index.ts');
    const result = buildDiffContext('', diff);
    expect(result.context).toContain('DIFF:');
    expect(result.context).toContain('diff --git a/src/index.ts');
    expect(result.includedFiles).toEqual(['src/index.ts']);
    expect(result.skippedFiles).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('skips lock files and records them in skippedFiles', () => {
    const diff = makeDiffSection('pnpm-lock.yaml');
    const result = buildDiffContext('', diff);
    expect(result.context).not.toContain('DIFF:');
    expect(result.skippedFiles).toContain('pnpm-lock.yaml');
    expect(result.includedFiles).toEqual([]);
  });

  it('skips binary file sections', () => {
    const diff = `diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n`;
    const result = buildDiffContext('', diff);
    expect(result.skippedFiles).toContain('image.png');
    expect(result.includedFiles).toEqual([]);
  });

  it('skips GIT binary patch sections', () => {
    const diff = `diff --git a/logo.png b/logo.png\nGIT binary patch\nliteral 100\nzcmV\n`;
    const result = buildDiffContext('', diff);
    expect(result.skippedFiles).toContain('logo.png');
  });

  it('truncates individual file diffs that exceed DIFF_MAX_CHARS_PER_FILE', () => {
    const longContent = 'x'.repeat(DIFF_MAX_CHARS_PER_FILE + 500);
    const diff = makeDiffSection('big.ts', longContent);
    const result = buildDiffContext('', diff);
    expect(result.context).toContain('...(file diff truncated)...');
    expect(result.includedFiles).toContain('big.ts');
    expect(result.truncated).toBe(false);
  });

  it('stops adding files once total chars exceed DIFF_MAX_TOTAL_CHARS', () => {
    // Use small sections (well under per-file limit) to accumulate past total limit.
    // DIFF_MAX_TOTAL_CHARS=6000, DIFF_MAX_CHARS_PER_FILE=1500.
    // Each section ~1000 chars; 7 sections = ~7000 > 6000.
    const content = 'x'.repeat(1000);
    const sections = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']
      .map((f) => makeDiffSection(f, content))
      .join('');
    const result = buildDiffContext('', sections);
    expect(result.truncated).toBe(true);
    expect(result.includedFiles).not.toContain('g.ts');
  });

  it('includes partial content of the file that pushes over the total limit', () => {
    // 4 filler sections × ~1376 chars each = ~5504; remaining budget = ~496 > 100,
    // so the last section gets partially included with a truncation marker.
    // Each section must stay under DIFF_MAX_CHARS_PER_FILE (1500).
    const content = 'x'.repeat(1300);
    const filler = ['c.ts', 'd.ts', 'e.ts', 'f.ts'].map((f) => makeDiffSection(f, content)).join('');
    const last = makeDiffSection('b.ts', 'y'.repeat(1300));
    const diff = filler + last;
    const result = buildDiffContext('', diff);
    expect(result.truncated).toBe(true);
    expect(result.context).toContain('...(diff truncated, remaining files omitted)...');
  });

  it('omits the overflow section when remaining chars <= 100', () => {
    // Build sections that leave fewer than 100 chars of budget for the last file.
    // Use many small equal sections so we can land just under the limit.
    // 5 sections × 1100 chars each = 5500; final section is small → remaining < 500.
    // Tweak: use 5 sections of 1180 chars = 5900 remaining = 100 → last file dropped.
    const content = 'x'.repeat(1180);
    const fillers = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']
      .map((f) => makeDiffSection(f, content))
      .join('');
    // The last file: small content but the remaining budget will be < 100.
    const last = makeDiffSection('z.ts', 'tiny');
    const diff = fillers + last;
    const result = buildDiffContext('', diff);
    expect(result.truncated).toBe(true);
    expect(result.context).not.toContain('z.ts');
  });

  it('lists skipped files in the SKIPPED line', () => {
    const diff = makeDiffSection('pnpm-lock.yaml') + makeDiffSection('src/app.ts');
    const result = buildDiffContext('', diff);
    expect(result.context).toContain('SKIPPED (lock/generated/binary): pnpm-lock.yaml');
    expect(result.includedFiles).toContain('src/app.ts');
  });

  it('includes both stat and diff sections when both are present', () => {
    const diff = makeDiffSection('lib/foo.ts', 'changed content');
    const result = buildDiffContext('2 files changed', diff);
    expect(result.context).toContain('CHANGES:');
    expect(result.context).toContain('DIFF:');
  });

  it('handles multiple valid diff sections', () => {
    const diff = makeDiffSection('a.ts') + makeDiffSection('b.ts');
    const result = buildDiffContext('', diff);
    expect(result.includedFiles).toEqual(['a.ts', 'b.ts']);
    expect(result.truncated).toBe(false);
  });

  it('omits SKIPPED section when nothing is skipped', () => {
    // Negative-space assertion: when every diff section makes it through,
    // the rendered context should NOT include a "SKIPPED" header. Without
    // this, regressions that always emit the header even with an empty
    // list would slip past.
    const diff = makeDiffSection('src/app.ts', '+const x = 1;\n');
    const result = buildDiffContext('', diff);
    expect(result.context).not.toContain('SKIPPED');
  });
});

// Realistic mixed-content diff covering a feature + bug fix + refactor + lock
// file + binary + dist output. Lives as an integration-flavored fixture
// (separate describe block) so the unit-style cases above stay focused on
// boundary semantics, while these exercise the helper end-to-end with
// inputs that look like what `git diff` actually emits.
const REALISTIC_BIG_DIFF = `diff --git a/lib/diff-context.ts b/lib/diff-context.ts
index 0000000..1234abc 100644
--- /dev/null
+++ b/lib/diff-context.ts
@@ -0,0 +1,68 @@
+export function buildDiffContext(stat: string, rawDiff: string): DiffContextResult {
+  return { context: '', includedFiles: [], skippedFiles: [], truncated: false };
+}
+export function shouldSkipFile(filename: string): boolean { return false; }
+export interface DiffContextResult {}
diff --git a/lib/start-push.ts b/lib/start-push.ts
index aabbcc..ddeeff 100644
--- a/lib/start-push.ts
+++ b/lib/start-push.ts
@@ -1,6 +1,7 @@
+import { buildDiffContext } from './diff-context';
diff --git a/components/ProjectDetailPage.tsx b/components/ProjectDetailPage.tsx
index 111222..333444 100644
--- a/components/ProjectDetailPage.tsx
+++ b/components/ProjectDetailPage.tsx
@@ -42,7 +42,7 @@ export function ProjectDetailPage({ project }: Props) {
-  const handlePush = async () => {
+  const handleRelease = async () => {
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index aaaaaa..bbbbbb 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,6 +1,6 @@
-  autoInstallPeers: false
+  autoInstallPeers: true
diff --git a/public/logo.png b/public/logo.png
index 0000000..9876543 100644
Binary files a/public/logo.png and b/public/logo.png differ
diff --git a/dist/bundle.js b/dist/bundle.js
index cccccc..dddddd 100644
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -1,3 +1,3 @@
-!function(e){var t={};return o.l=!0,o.exports}n.m=e,n.c=t}
+!function(e){var t={};return o.l=!1,o.exports}n.m=e,n.c=t}
`;

const REALISTIC_STAT = ` lib/diff-context.ts               | 68 +++++++++++++++++++++++++++++++++++++
 lib/start-push.ts                  |  4 ++-
 components/ProjectDetailPage.tsx   |  4 +--
 pnpm-lock.yaml                     | 12 ++++---
 public/logo.png                    |Bin 0 -> 4321 bytes
 dist/bundle.js                     |  2 +-
 6 files changed, 88 insertions(+), 4 deletions(-)
`;

describe('buildDiffContext — realistic big diff', () => {
  it('includes source files and excludes noise (lock/binary/dist)', () => {
    const { includedFiles, skippedFiles } = buildDiffContext(REALISTIC_STAT, REALISTIC_BIG_DIFF);
    expect(includedFiles).toContain('lib/diff-context.ts');
    expect(includedFiles).toContain('lib/start-push.ts');
    expect(includedFiles).toContain('components/ProjectDetailPage.tsx');
    expect(skippedFiles).toContain('pnpm-lock.yaml');
    expect(skippedFiles).toContain('public/logo.png');
    expect(skippedFiles).toContain('dist/bundle.js');
  });

  it('preserves key semantic identifiers from the diff', () => {
    // The downstream consumer (commit-message generation) only writes a
    // good message if the function/type names and the renamed handler
    // survive into the context.
    const { context } = buildDiffContext(REALISTIC_STAT, REALISTIC_BIG_DIFF);
    expect(context).toContain('buildDiffContext');
    expect(context).toContain('shouldSkipFile');
    expect(context).toContain('DiffContextResult');
    expect(context).toContain('handleRelease');
    expect(context).toContain('diff-context');
  });

  it('does not leak lock file or binary content into the context', () => {
    const { context } = buildDiffContext(REALISTIC_STAT, REALISTIC_BIG_DIFF);
    // Lock file internals must not appear
    expect(context).not.toContain('autoInstallPeers');
    // Binary diff marker must not appear
    expect(context).not.toContain('Binary files');
    // Minified bundle content must not appear
    expect(context).not.toContain('!function(e)');
  });

  it('stays within the per-file + total char budget', () => {
    const { context } = buildDiffContext(REALISTIC_STAT, REALISTIC_BIG_DIFF);
    expect(context.length).toBeLessThanOrEqual(DIFF_MAX_TOTAL_CHARS + REALISTIC_STAT.length + 200);
  });

  it('reports skipped files only in the SKIPPED line, not as diff hunks', () => {
    const { context } = buildDiffContext(REALISTIC_STAT, REALISTIC_BIG_DIFF);
    expect(context).toContain('pnpm-lock.yaml');
    expect(context).toContain('public/logo.png');
    expect(context).toContain('dist/bundle.js');
    // Hunks for those files must NOT appear elsewhere
    expect(context).not.toContain('autoInstallPeers');
  });
});
