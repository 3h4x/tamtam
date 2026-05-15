/**
 * Tiny POSIX-ish command splitter: takes a command line as a single string
 * and returns argv[]. Quoted segments stay whole, backslash escapes one
 * character. No expansion of $VAR, no pipes, no command substitution — call
 * sites that pass real shell pipelines bypass this and shell out via bash.
 *
 * Used by step bodies that read `claudeCommand`-style strings from settings
 * and need to spawn them as `[bin, ...args]`.
 */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && i + 1 < line.length) { buf += line[++i]; continue; }
      if (ch === quote) { quote = null; continue; }
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
    } else if (ch === ' ' || ch === '\t') {
      if (buf) { out.push(buf); buf = ''; }
    } else if (ch === '\\' && i + 1 < line.length) {
      buf += line[++i];
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}
