export const ISSUE_BODY_TEMPLATE = `## Problem
<one paragraph describing the gap and why it matters>

## Proposed approach
<bulleted or short-paragraph plan>

## Acceptance criteria
- [ ] <verifiable outcome 1>
- [ ] <verifiable outcome 2>`;

export const ISSUE_FORMAT_INSTRUCTION = `Use this exact body template (sections in this order, \`- [ ]\` checkboxes for each criterion so TamTam's mark-dod step can tick them):

\`\`\`md
${ISSUE_BODY_TEMPLATE}
\`\`\``;

export function normalizeAcceptanceCriteria(body: string): string {
  const lines = body.split('\n');
  let inAcceptanceCriteria = false;

  return lines.map((line) => {
    if (/^##\s+acceptance criteria\s*$/i.test(line.trim())) {
      inAcceptanceCriteria = true;
      return line;
    }
    if (inAcceptanceCriteria && /^##\s+/.test(line)) {
      inAcceptanceCriteria = false;
    }
    if (!inAcceptanceCriteria) return line;
    if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) return line;
    return line.replace(/^(\s*[-*]\s+)(?!\[)(.+)$/, '$1[ ] $2');
  }).join('\n');
}
