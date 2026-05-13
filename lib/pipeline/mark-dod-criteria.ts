// Pure helpers for parsing and updating GitHub issue/PR DoD checkboxes.
// No DB or heavy imports — safe to statically import in tests.

export function extractCriteria(body: string): Array<{ raw: string; text: string }> {
  const out: Array<{ raw: string; text: string }> = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^(\s*[-*]\s+)\[\s\]\s+(.+)$/);
    if (m) out.push({ raw: line, text: m[2].trim() });
  }
  return out;
}

export function tickCriteria(body: string, verifiedTexts: Set<string>): { body: string; ticked: number } {
  let ticked = 0;
  const out = body.split('\n').map(line => {
    const m = line.match(/^(\s*[-*]\s+)\[\s\](\s+)(.+)$/);
    if (!m) return line;
    const text = m[3].trim();
    if (verifiedTexts.has(text)) {
      ticked++;
      return `${m[1]}[x]${m[2]}${m[3]}`;
    }
    return line;
  }).join('\n');
  return { body: out, ticked };
}
