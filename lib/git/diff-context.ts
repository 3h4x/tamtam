const SKIP_FILE_PATTERNS = [
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /Cargo\.lock$/,
  /composer\.lock$/,
  /Gemfile\.lock$/,
  /poetry\.lock$/,
  /bun\.lockb$/,
  /\.min\.(js|css)$/,
  /dist\//,
  /\.next\//,
  /build\//,
];

export const DIFF_MAX_CHARS_PER_FILE = 1500;
export const DIFF_MAX_TOTAL_CHARS = 6000;

export function shouldSkipFile(filename: string): boolean {
  return SKIP_FILE_PATTERNS.some((re) => re.test(filename));
}

export interface DiffContextResult {
  context: string;
  includedFiles: string[];
  skippedFiles: string[];
  truncated: boolean;
}

/**
 * Builds a compact, token-efficient diff context for commit message generation.
 *
 * Strategy:
 * - Always include the stat summary (small, gives Claude file-level overview)
 * - Filter out lock files, minified files, build output — they're noise
 * - Cap each file's diff at DIFF_MAX_CHARS_PER_FILE
 * - Stop adding files once DIFF_MAX_TOTAL_CHARS is reached
 * - Report skipped files so Claude knows they were intentionally omitted
 */
export function buildDiffContext(stat: string, rawDiff: string): DiffContextResult {
  const sections = rawDiff.split(/(?=^diff --git )/m).filter((s) => s.trim());

  const included: string[] = [];
  const includedFiles: string[] = [];
  const skippedFiles: string[] = [];
  let totalChars = 0;
  let truncated = false;

  for (const section of sections) {
    const match = section.match(/^diff --git a\/(.+?) b\//m);
    const filename = match?.[1] ?? '';

    if (filename && shouldSkipFile(filename)) {
      skippedFiles.push(filename);
      continue;
    }

    if (section.includes('Binary files') || section.includes('GIT binary patch')) {
      skippedFiles.push(filename || '(binary)');
      continue;
    }

    const filePart =
      section.length > DIFF_MAX_CHARS_PER_FILE
        ? section.slice(0, DIFF_MAX_CHARS_PER_FILE) + '\n...(file diff truncated)...'
        : section;

    if (totalChars + filePart.length > DIFF_MAX_TOTAL_CHARS) {
      const remaining = DIFF_MAX_TOTAL_CHARS - totalChars;
      if (remaining > 100) {
        included.push(filePart.slice(0, remaining) + '\n...(diff truncated, remaining files omitted)...');
      }
      truncated = true;
      break;
    }

    included.push(filePart);
    if (filename) includedFiles.push(filename);
    totalChars += filePart.length;
  }

  const parts: string[] = [];
  if (stat.trim()) parts.push(`CHANGES:\n${stat.trim()}`);
  if (skippedFiles.length > 0) parts.push(`SKIPPED (lock/build/binary): ${skippedFiles.join(', ')}`);
  if (included.length > 0) parts.push(`DIFF:\n${included.join('\n')}`);

  return { context: parts.join('\n\n'), includedFiles, skippedFiles, truncated };
}
