import { describe, it, expect } from 'vitest';
import { buildDiffContext, shouldSkipFile, DIFF_MAX_CHARS_PER_FILE, DIFF_MAX_TOTAL_CHARS } from '../lib/diff-context';

// Realistic large diff: new feature + bug fix + refactor + lock file + binary + dist output
const REALISTIC_BIG_DIFF = `diff --git a/lib/diff-context.ts b/lib/diff-context.ts
index 0000000..1234abc 100644
--- /dev/null
+++ b/lib/diff-context.ts
@@ -0,0 +1,68 @@
+const SKIP_FILE_PATTERNS = [
+  /package-lock\\.json$/,
+  /pnpm-lock\\.yaml$/,
+  /yarn\\.lock$/,
+];
+
+export const DIFF_MAX_CHARS_PER_FILE = 1500;
+export const DIFF_MAX_TOTAL_CHARS = 6000;
+
+export function shouldSkipFile(filename: string): boolean {
+  return SKIP_FILE_PATTERNS.some((re) => re.test(filename));
+}
+
+export interface DiffContextResult {
+  context: string;
+  includedFiles: string[];
+  skippedFiles: string[];
+  truncated: boolean;
+}
+
+export function buildDiffContext(stat: string, rawDiff: string): DiffContextResult {
+  const sections = rawDiff.split(/(?=^diff --git )/m).filter((s) => s.trim());
+  const included: string[] = [];
+  const skippedFiles: string[] = [];
+  // ... implementation
+  return { context: '', includedFiles: [], skippedFiles, truncated: false };
+}
diff --git a/lib/start-push.ts b/lib/start-push.ts
index aabbcc..ddeeff 100644
--- a/lib/start-push.ts
+++ b/lib/start-push.ts
@@ -1,6 +1,7 @@
 import { resolveProjectPath } from './project-data';
 import { exec } from './shell';
 import { getSettings } from './config';
+import { buildDiffContext } from './diff-context';

 async function generateCommitMessage(projPath: string, projectName: string): Promise<string> {
-  const diffContent = diffR.stdout.trim();
-  const diffSection = diffContent ? \`\\n\\nDIFF:\\n\${diffContent}\` : '';
+  const { context } = buildDiffContext(statR.stdout, diffR.stdout);
   const styleGuide = (getSettings().commit_style ?? '').trim();
diff --git a/components/ProjectDetailPage.tsx b/components/ProjectDetailPage.tsx
index 111222..333444 100644
--- a/components/ProjectDetailPage.tsx
+++ b/components/ProjectDetailPage.tsx
@@ -42,7 +42,7 @@ export function ProjectDetailPage({ project }: Props) {
-  const handlePush = async () => {
+  const handleRelease = async () => {
     setLoading(true);
     try {
-      await fetch(\`/api/projects/by-project/\${project.name}/push\`, { method: 'POST' });
+      await fetch(\`/api/projects/by-project/\${project.name}/release\`, { method: 'POST' });
     } finally {
       setLoading(false);
     }
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index aaaaaa..bbbbbb 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,6 +1,6 @@
 lockfileVersion: '6.0'

 settings:
-  autoInstallPeers: false
+  autoInstallPeers: true

 dependencies:
   next:
@@ -100,3 +100,4 @@
+  vitest:
+    specifier: ^2.0.0
+    version: 2.0.0
diff --git a/public/logo.png b/public/logo.png
index 0000000..9876543 100644
Binary files a/public/logo.png and b/public/logo.png differ
diff --git a/dist/bundle.js b/dist/bundle.js
index cccccc..dddddd 100644
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -1,3 +1,3 @@
-!function(e){var t={};function n(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};return e[r].call(o.exports,o,o.exports,n),o.l=!0,o.exports}n.m=e,n.c=t}
+!function(e){var t={};function n(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!0,exports:{}};return e[r].call(o.exports,o,o.exports,n),o.l=!0,o.exports}n.m=e,n.c=t}
diff --git a/__tests__/diff-context.test.ts b/__tests__/diff-context.test.ts
index 0000000..ababab 100644
--- /dev/null
+++ b/__tests__/diff-context.test.ts
@@ -0,0 +1,20 @@
+import { describe, it, expect } from 'vitest';
+import { buildDiffContext } from '../lib/diff-context';
+
+describe('buildDiffContext', () => {
+  it('skips lock files', () => {
+    const { skippedFiles } = buildDiffContext('', lockDiff);
+    expect(skippedFiles).toContain('pnpm-lock.yaml');
+  });
+});
`;

const REALISTIC_STAT = ` lib/diff-context.ts               | 68 +++++++++++++++++++++++++++++++++++++
 lib/start-push.ts                  |  4 ++-
 components/ProjectDetailPage.tsx   |  4 +--
 pnpm-lock.yaml                     | 12 ++++---
 public/logo.png                    |Bin 0 -> 4321 bytes
 dist/bundle.js                     |  2 +-
 __tests__/diff-context.test.ts     | 20 +++++++++++
 7 files changed, 95 insertions(+), 15 deletions(-)
`;

const makeDiffSection = (filename: string, content: string, extra = '') =>
  `diff --git a/${filename} b/${filename}\nindex abc..def 100644\n--- a/${filename}\n+++ b/${filename}\n${extra}${content}`;

const makeLargeDiffSection = (filename: string, size: number) =>
  makeDiffSection(filename, '+' + 'x'.repeat(size));

describe('shouldSkipFile', () => {
  it('skips lock files', () => {
    expect(shouldSkipFile('package-lock.json')).toBe(true);
    expect(shouldSkipFile('pnpm-lock.yaml')).toBe(true);
    expect(shouldSkipFile('yarn.lock')).toBe(true);
    expect(shouldSkipFile('Cargo.lock')).toBe(true);
    expect(shouldSkipFile('composer.lock')).toBe(true);
    expect(shouldSkipFile('Gemfile.lock')).toBe(true);
    expect(shouldSkipFile('poetry.lock')).toBe(true);
    expect(shouldSkipFile('bun.lockb')).toBe(true);
  });

  it('skips minified and build output files', () => {
    expect(shouldSkipFile('bundle.min.js')).toBe(true);
    expect(shouldSkipFile('styles.min.css')).toBe(true);
    expect(shouldSkipFile('dist/app.js')).toBe(true);
    expect(shouldSkipFile('.next/server/app.js')).toBe(true);
    expect(shouldSkipFile('build/index.html')).toBe(true);
  });

  it('does not skip regular source files', () => {
    expect(shouldSkipFile('src/index.ts')).toBe(false);
    expect(shouldSkipFile('lib/utils.ts')).toBe(false);
    expect(shouldSkipFile('package.json')).toBe(false);
    expect(shouldSkipFile('README.md')).toBe(false);
    expect(shouldSkipFile('app/page.tsx')).toBe(false);
  });
});

describe('buildDiffContext', () => {
  it('includes stat summary and diff for a normal file', () => {
    const stat = ' src/index.ts | 5 ++---\n 1 file changed';
    const raw = makeDiffSection('src/index.ts', '@@ -1 +1 @@\n-old\n+new\n');
    const { context, includedFiles, skippedFiles } = buildDiffContext(stat, raw);

    expect(context).toContain('CHANGES:');
    expect(context).toContain('1 file changed');
    expect(context).toContain('DIFF:');
    expect(context).toContain('src/index.ts');
    expect(includedFiles).toContain('src/index.ts');
    expect(skippedFiles).toHaveLength(0);
  });

  it('skips lock files and reports them', () => {
    const stat = ' pnpm-lock.yaml | 200 ++++---\n 1 file changed';
    const raw = makeDiffSection('pnpm-lock.yaml', '@@ -1 +1 @@\n-old\n+new\n');
    const { context, skippedFiles, includedFiles } = buildDiffContext(stat, raw);

    expect(skippedFiles).toContain('pnpm-lock.yaml');
    expect(includedFiles).not.toContain('pnpm-lock.yaml');
    expect(context).toContain('SKIPPED');
    expect(context).toContain('pnpm-lock.yaml');
    expect(context).not.toContain('@@ -1 +1 @@');
  });

  it('skips binary files', () => {
    const raw = `diff --git a/image.png b/image.png\nindex abc..def 100644\nBinary files a/image.png and b/image.png differ\n`;
    const { skippedFiles, context } = buildDiffContext('', raw);

    expect(skippedFiles.length).toBeGreaterThan(0);
    expect(context).toContain('SKIPPED');
    expect(context).not.toContain('Binary files');
  });

  it('truncates a single large file diff at DIFF_MAX_CHARS_PER_FILE', () => {
    const raw = makeLargeDiffSection('big.ts', DIFF_MAX_CHARS_PER_FILE + 500);
    const { context } = buildDiffContext('', raw);

    expect(context).toContain('(file diff truncated)');
  });

  it('stops adding files once DIFF_MAX_TOTAL_CHARS is reached', () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      makeLargeDiffSection(`file${i}.ts`, 1200)
    );
    const raw = files.join('\n');
    const { context, truncated } = buildDiffContext('', raw);

    expect(truncated).toBe(true);
    expect(context.length).toBeLessThanOrEqual(DIFF_MAX_TOTAL_CHARS + 200);
  });

  it('includes mixed content: skips locks, includes source files', () => {
    const lockSection = makeDiffSection('package-lock.json', '+some lockfile content\n');
    const srcSection = makeDiffSection('lib/feature.ts', '@@ -1 +1 @@\n+export const x = 1;\n');
    const raw = [lockSection, srcSection].join('\n');

    const { includedFiles, skippedFiles } = buildDiffContext('', raw);

    expect(skippedFiles).toContain('package-lock.json');
    expect(includedFiles).toContain('lib/feature.ts');
  });

  it('handles empty diff gracefully', () => {
    const { context, includedFiles, skippedFiles, truncated } = buildDiffContext('', '');

    expect(context).toBe('');
    expect(includedFiles).toHaveLength(0);
    expect(skippedFiles).toHaveLength(0);
    expect(truncated).toBe(false);
  });

  it('includes stat even when all files are skipped', () => {
    const stat = ' pnpm-lock.yaml | 50 +++\n 1 file changed';
    const raw = makeDiffSection('pnpm-lock.yaml', '+x\n');
    const { context } = buildDiffContext(stat, raw);

    expect(context).toContain('CHANGES:');
    expect(context).toContain('1 file changed');
    expect(context).not.toContain('DIFF:');
  });

  it('omits SKIPPED section when nothing is skipped', () => {
    const raw = makeDiffSection('src/app.ts', '+const x = 1;\n');
    const { context } = buildDiffContext('', raw);

    expect(context).not.toContain('SKIPPED');
  });
});

describe('buildDiffContext — realistic big diff', () => {
  it('includes all three source files and excludes noise', () => {
    const { includedFiles, skippedFiles } = buildDiffContext(REALISTIC_STAT, REALISTIC_BIG_DIFF);

    expect(includedFiles).toContain('lib/diff-context.ts');
    expect(includedFiles).toContain('lib/start-push.ts');
    expect(includedFiles).toContain('components/ProjectDetailPage.tsx');
    expect(includedFiles).toContain('__tests__/diff-context.test.ts');

    expect(skippedFiles).toContain('pnpm-lock.yaml');
    expect(skippedFiles).toContain('public/logo.png');
    expect(skippedFiles).toContain('dist/bundle.js');
  });

  it('preserves key semantic identifiers from the diff', () => {
    const { context } = buildDiffContext(REALISTIC_STAT, REALISTIC_BIG_DIFF);

    // New file: function and type names Claude needs to write a good commit
    expect(context).toContain('buildDiffContext');
    expect(context).toContain('shouldSkipFile');
    expect(context).toContain('DiffContextResult');

    // Bug fix: renamed handler in the component
    expect(context).toContain('handleRelease');

    // Refactor: import added to start-push
    expect(context).toContain('diff-context');
  });

  it('includes the stat summary so Claude sees the full scope of changes', () => {
    const { context } = buildDiffContext(REALISTIC_STAT, REALISTIC_BIG_DIFF);

    expect(context).toContain('7 files changed');
    expect(context).toContain('95 insertions');
  });

  it('does not leak lock file or binary content into the context', () => {
    const { context } = buildDiffContext(REALISTIC_STAT, REALISTIC_BIG_DIFF);

    // Lock file internals must not appear
    expect(context).not.toContain('autoInstallPeers');
    expect(context).not.toContain('specifier');

    // Binary diff marker must not appear
    expect(context).not.toContain('Binary files');

    // Minified bundle content must not appear
    expect(context).not.toContain('!function(e)');
  });

  it('stays within token budget', () => {
    const { context } = buildDiffContext(REALISTIC_STAT, REALISTIC_BIG_DIFF);

    // DIFF_MAX_TOTAL_CHARS is 6000; stat adds a small fixed overhead
    expect(context.length).toBeLessThanOrEqual(DIFF_MAX_TOTAL_CHARS + REALISTIC_STAT.length + 200);
  });

  it('reports skipped files by name so Claude understands what was omitted', () => {
    const { context } = buildDiffContext(REALISTIC_STAT, REALISTIC_BIG_DIFF);

    expect(context).toContain('pnpm-lock.yaml');
    expect(context).toContain('public/logo.png');
    expect(context).toContain('dist/bundle.js');
    // but only in the SKIPPED section, not as diff hunks
    expect(context).not.toContain('autoInstallPeers');
  });
});
