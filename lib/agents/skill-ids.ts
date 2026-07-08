export const ISSUE_CRUNCHER_SKILL_ID = 'agent-issue-cruncher';
export const IMPROVE_SKILL_ID = 'agent-improve';
export const QA_SKILL_ID = 'agent-qa';
export const HEALTH_SKILL_ID = 'agent-health';

// Paths used by the improve agent's prerequisite command and tests.
export const IMPROVE_AUDIT_PATH = '.tamtam/cache/audits/improve.md';
// Content-addressed ledger of audited files: one git blob SHA per line. A file is
// re-audited only when its bytes change (new SHA), so unchanged files drop out of the
// candidate queue without relying on filesystem mtime. Lives in the gitignored cache.
export const IMPROVE_LEDGER_PATH = '.tamtam/cache/audits/improve-ledger.txt';
