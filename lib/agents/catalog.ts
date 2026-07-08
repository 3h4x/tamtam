// The agent catalog — a single source of truth for every built-in agent
// definition TamTam ships with. One shape describes the whole built-in
// surface via explicit axes:
//
//   - `dispatch: 'internal' | 'cli'` — how the agent runs.
//   - `autoSeed: boolean` — whether the seeder materializes the entry into
//     every project at boot.
//   - `tier?` — optional UI prioritization for the suggested-templates
//     panel.
//
// `SYSTEM_AGENTS` (lib/agents/system) and `RECOMMENDED_AGENTS`
// (lib/agents/recommended-agents) are thin adapters that derive from this
// catalog, so those call sites stay in sync automatically.

import { ISSUE_CRUNCHER_SKILL_ID, HEALTH_SKILL_ID } from '@/lib/agents/skill-ids';
import { DOCUMENTATION_REINDEX_VECTORS_AGENT_NAME } from '@/lib/agents/system/constants';
import type { AgentRole } from '@/lib/agents/roles';

export type AgentDispatch = 'cli' | 'internal';
export type AgentTier = 'essential' | 'featured' | 'recommended';
export type AgentHandlerKey = 'documentation-reindex-vectors';

export interface AgentCatalogEntry {
  /** Canonical name; used as the agent identifier on materialization. */
  name: string;
  /** Alternate names that should resolve to this entry for compatibility. */
  aliases?: string[];
  /** One-line UI description (suggested-templates tile + agent table tooltip). */
  description: string;

  /** Execution model: `internal` resolves `handlerKey` server-side; `cli` spawns a
   *  provider CLI via the standard agent intake workflow. */
  dispatch: AgentDispatch;
  /** Required when `dispatch === 'internal'`. Ignored for `cli` entries.
   *  The actual runner is deliberately resolved in `lib/agents/system` so
   *  client-side catalog consumers never import Node-only server modules. */
  handlerKey?: AgentHandlerKey;

  /** Defaults applied when the entry is materialized into a project. */
  defaultSchedule: string;
  defaultModel: string;
  prompt: string;
  skillIds: string[];

  /** When true, the seeder creates a DB row for this entry in every
   *  enabled project at boot. False (default) means the entry stays a
   *  template and only materializes when the user installs it. */
  autoSeed?: boolean;
  /** Surfacing tier in the suggested-templates panel. Drives default
   *  expand/collapse + ordering, not eligibility. */
  tier?: AgentTier;
  /** When true, runs that fail on the primary provider may retry once on
   *  the fallback provider. Mirrors the legacy recommended-agent flag. */
  fallbackEnabled?: boolean;
  /** Seeded agent role. Omitted ⇒ 'producer'. 'monitor' makes the agent
   *  never diff-judged (never unfruitful / schedule-backed-off) and
   *  model-downgrade-only under autopilot. See lib/agents/roles.ts. */
  role?: AgentRole;
  /** Seeded boostable flag. Omitted ⇒ true. false ⇒ the orchestrator never
   *  boost-fires it; it runs only on its own schedule. */
  boostable?: boolean;
  /** External references that inspired the agent — surfaced in the
   *  catalog UI so future maintainers can trace why a built-in exists
   *  and where its design vocabulary came from. */
  inspiration?: ReadonlyArray<{ label: string; url: string }>;
}

// The canonical catalog. Order is meaningful only for tie-breaking inside
// a tier — the UI sorts by tier first.
export const AGENT_CATALOG: AgentCatalogEntry[] = [
  // ── Internal-dispatch agents (auto-seeded per project) ────────────────────
  {
    name: DOCUMENTATION_REINDEX_VECTORS_AGENT_NAME,
    description:
      'Auto-managed: refreshes the pgvector retrieval corpus for this project, ' +
      'wipes stale embeddings when the embedding model changes, and verifies ' +
      'result quality with a small local LLM. Disable per project from the ' +
      'agents UI; schedule is managed from Settings > Retrieval.',
    dispatch: 'internal',
    handlerKey: 'documentation-reindex-vectors',
    defaultSchedule: '16h',
    defaultModel: 'normal',
    prompt:
      'Auto-managed: refreshes the pgvector retrieval corpus for this project, ' +
      'wipes stale embeddings when the embedding model changes, and verifies ' +
      'result quality with a small local LLM. Disable per project from the ' +
      'agents UI; schedule is managed from Settings > Retrieval.',
    skillIds: [],
    autoSeed: true,
  },

  // ── CLI-dispatch agent, auto-seeded per project (LLM-backed monitor) ──────
  {
    name: 'health',
    description:
      "Auto-managed: checks whether this project's deployed app is up where it " +
      'should be, presents data, and is healthy — reading its logs. Reports a ' +
      'verdict; DEGRADED surfaces in recommendations, DOWN as a red inbox blocker. ' +
      "Read-only. Configure per-app checks in the project's docs/HEALTH.md.",
    dispatch: 'cli',
    autoSeed: true,
    role: 'monitor',
    boostable: false,
    defaultSchedule: '1h',
    defaultModel: 'claude-haiku-4-5-20251001',
    prompt:
      'Run the project health monitor for this project: is the deployed app up ' +
      'where it should be, does it present data, is it healthy? Read its logs. ' +
      'Follow the agent-health skill and end with a HEALTH_VERDICT line.',
    skillIds: [HEALTH_SKILL_ID],
    fallbackEnabled: true,
  },

  // ── CLI-dispatch agents (templates; not auto-seeded) ──────────────────────
  {
    name: 'issue-cruncher',
    description:
      'Picks a ready-to-go GitHub issue, implements it, and hands off to the release pipeline. Closes stale or unverifiable issues by default, and uses needs-info only for recently active authors with a specific unblocker.',
    dispatch: 'cli',
    defaultSchedule: '',
    defaultModel: 'normal',
    prompt: '',
    skillIds: [ISSUE_CRUNCHER_SKILL_ID],
    tier: 'featured',
    fallbackEnabled: true,
  },
  {
    name: 'security-review',
    description: 'Scans uncommitted diffs for OWASP issues, secrets, and vulnerabilities.',
    dispatch: 'cli',
    defaultSchedule: '24h',
    defaultModel: 'normal',
    prompt: '',
    skillIds: ['agent-security-review'],
    fallbackEnabled: true,
  },
  {
    name: 'dependency-check',
    description: 'Scans for outdated or vulnerable dependencies and suggests updates.',
    dispatch: 'cli',
    defaultSchedule: '24h',
    defaultModel: 'normal',
    prompt: '',
    skillIds: ['agent-dependency-check'],
    fallbackEnabled: true,
  },
  {
    name: 'ci-monitor',
    description: 'Checks GitHub Actions status and applies fixes when the latest run fails.',
    dispatch: 'cli',
    defaultSchedule: '30m',
    defaultModel: 'normal',
    prompt: '',
    skillIds: ['agent-ci-monitor'],
    fallbackEnabled: true,
  },
  {
    name: 'release-ready',
    description: 'Pre-flight check: runs tests and surfaces whether the project is ready to ship.',
    dispatch: 'cli',
    defaultSchedule: '24h',
    defaultModel: 'normal',
    prompt: '',
    skillIds: ['agent-release-ready'],
    fallbackEnabled: true,
  },
  {
    name: 'test-add',
    aliases: ['tests'],
    description: 'Adds missing tests for recently changed code and fills gaps in coverage.',
    dispatch: 'cli',
    defaultSchedule: '24h',
    defaultModel: 'normal',
    prompt: '',
    skillIds: ['agent-tests'],
    fallbackEnabled: true,
  },
  {
    // Metadata source of truth lives in skills/docs/skills/tamtam/agent-test-e2e.md.
    // The fields below are inline fallbacks; the .md `agent:` block overrides them at API serialize time.
    name: 'test-e2e',
    aliases: ['tests-e2e', 'e2e-tests'],
    description: 'Adds Playwright end-to-end tests for recently-changed UI / new routes. Matches the existing harness — no new abstractions per run.',
    dispatch: 'cli',
    defaultSchedule: '24h',
    defaultModel: 'normal',
    prompt: '',
    skillIds: ['agent-test-e2e'],
    fallbackEnabled: true,
  },
  {
    name: 'cto',
    description: 'Thinks from a CTO perspective about product direction and creates prioritized GitHub issues for missing features, gaps, and strategic improvements.',
    dispatch: 'cli',
    defaultSchedule: '24h',
    defaultModel: 'smart',
    prompt: '',
    skillIds: ['agent-cto'],
    fallbackEnabled: true,
  },
  {
    name: 'gha-audit',
    description: 'Audits GitHub Actions workflows and creates missing ones for CI, release, and labels.',
    dispatch: 'cli',
    defaultSchedule: '24h',
    defaultModel: 'normal',
    prompt: '',
    skillIds: ['agent-gha-audit'],
    fallbackEnabled: true,
  },
  {
    name: 'readme-sync',
    description: 'Verifies README.md is accurate and updates it to reflect the current state of the project.',
    dispatch: 'cli',
    defaultSchedule: '24h',
    defaultModel: 'normal',
    prompt: '',
    skillIds: ['agent-readme-sync'],
    fallbackEnabled: true,
  },
  {
    name: 'docs-claude',
    description: 'Audits CLAUDE.md for completeness — adds missing guidance on security, coding conventions, testing rules, and best patterns so Claude behaves correctly on every run.',
    dispatch: 'cli',
    defaultSchedule: '24h',
    defaultModel: 'normal',
    prompt: '',
    skillIds: ['agent-docs-claude'],
    tier: 'essential',
    fallbackEnabled: true,
  },
  {
    // Metadata source of truth lives in skills/docs/skills/tamtam/agent-docs-generate.md.
    // The fields below are inline fallbacks; the .md `agent:` block overrides them at API serialize time.
    name: 'docs-generate',
    description: 'Generates one new doc page per run for an under-documented subsystem (architecture / concept / comparison / synthesis). Never edits existing docs.',
    dispatch: 'cli',
    defaultSchedule: '24h',
    defaultModel: 'smart',
    prompt: '',
    skillIds: ['agent-docs-generate'],
    tier: 'essential',
    fallbackEnabled: true,
  },
  {
    name: 'qa',
    description: 'Browses the configured QA target with Playwright, fixes 1-2 small safe issues directly, and reports the rest.',
    dispatch: 'cli',
    defaultSchedule: '24h',
    defaultModel: 'normal',
    prompt: '',
    skillIds: ['agent-qa'],
    tier: 'featured',
    fallbackEnabled: true,
  },
  {
    // Metadata source of truth lives in skills/docs/skills/tamtam/agent-improve.md.
    // The fields below are inline fallbacks; the .md `agent:` block overrides them at API serialize time.
    name: 'improve',
    description: 'Walks the oldest size-budgeted source candidates, applies up to three safe family-rubric fixes per run, and records clean files in the audit ledger to rotate the queue. Verifies edits with type-check plus a targeted test for substantial fixes.',
    dispatch: 'cli',
    defaultSchedule: '12h',
    defaultModel: 'normal',
    prompt: '',
    skillIds: ['agent-improve'],
    tier: 'featured',
    fallbackEnabled: true,
  },
  {
    // Metadata source of truth lives in skills/docs/skills/tamtam/agent-refactor-split.md.
    // The fields below are inline fallbacks; the .md `agent:` block overrides them at API serialize time.
    name: 'refactor-split',
    description: "Consumes the improve agent's F6 oversized-file flags and safely splits one eligible file per run into focused modules.",
    dispatch: 'cli',
    defaultSchedule: '48h',
    defaultModel: 'smart',
    prompt: '',
    skillIds: ['agent-refactor-split'],
    tier: 'featured',
    fallbackEnabled: true,
  },
  {
    // Metadata source of truth lives in skills/docs/skills/tamtam/agent-dedupe.md.
    // The fields below are inline fallbacks; the .md `agent:` block overrides them at API serialize time.
    name: 'dedupe',
    description: 'Hunts byte-identical files, parallel implementations, and reimplemented helpers; consolidates one small safe case per run and flags the rest.',
    dispatch: 'cli',
    defaultSchedule: '7d',
    defaultModel: 'smart',
    prompt: '',
    skillIds: ['agent-dedupe'],
    tier: 'featured',
    fallbackEnabled: true,
  },
  {
    name: 'manage-agents',
    description: 'Audits TamTam agents for this project and creates, updates, or removes them to match current project needs.',
    dispatch: 'cli',
    defaultSchedule: '24h',
    defaultModel: 'normal',
    prompt: '',
    skillIds: ['agent-manage-agents'],
    tier: 'featured',
    fallbackEnabled: true,
  },
];

export function catalogNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function catalogNameKeys(entry: Pick<AgentCatalogEntry, 'name' | 'aliases'>): string[] {
  return [entry.name, ...(entry.aliases ?? [])]
    .map(catalogNameKey)
    .filter(Boolean);
}

// Precomputed index — turns `findCatalogEntry` into O(1) and saves the
// O(N × K) per-call scan over every entry's name + alias keys.
let _indexByNameKey: ReadonlyMap<string, AgentCatalogEntry> | null = null;
function getIndex(): ReadonlyMap<string, AgentCatalogEntry> {
  if (_indexByNameKey) return _indexByNameKey;
  const m = new Map<string, AgentCatalogEntry>();
  for (const entry of AGENT_CATALOG) {
    for (const key of catalogNameKeys(entry)) {
      m.set(key, entry);
    }
  }
  _indexByNameKey = m;
  return m;
}

export function findCatalogEntry(name: string): AgentCatalogEntry | null {
  return getIndex().get(catalogNameKey(name)) ?? null;
}

export function isInCatalog(name: string): boolean {
  return getIndex().has(catalogNameKey(name));
}

export function catalogEntriesByDispatch(dispatch: AgentDispatch): AgentCatalogEntry[] {
  return AGENT_CATALOG.filter((e) => e.dispatch === dispatch);
}

export function autoSeededCatalogEntries(): AgentCatalogEntry[] {
  return AGENT_CATALOG.filter((e) => e.autoSeed === true);
}
