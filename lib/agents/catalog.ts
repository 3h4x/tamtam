// The agent catalog — a single source of truth for every built-in agent
// definition TamTam ships with.
//
// Before this file, agents lived in three places with three shapes:
//
//   - `lib/agents/system/index.ts` exposed `SYSTEM_AGENTS`, a registry of
//     auto-seeded internal-handler agents (e.g. `documentation-reindex-vectors`).
//   - `lib/agents/recommended-agents.ts` exposed `RECOMMENDED_AGENTS`, a
//     static template list rendered as "Suggested Templates" tiles.
//   - File-based `.tamtam/agents/*.md` were the third source, scanned at
//     request time and project-scoped by location.
//
// The split made "where do I add a new agent?" confusing and made it hard
// to express agents that share traits across categories (e.g. an internal
// agent that's not auto-seeded). This file unifies the built-in surface
// into one shape with explicit axes:
//
//   - `dispatch: 'internal' | 'cli'` — how the agent runs.
//   - `autoSeed: boolean` — whether the seeder materializes the entry into
//     every project at boot.
//   - `tier?` — optional UI prioritization for the suggested-templates
//     panel.
//
// The legacy `SYSTEM_AGENTS` and `RECOMMENDED_AGENTS` exports are now thin
// adapters that derive from the catalog so existing call sites keep
// working unchanged.

import { ISSUE_CRUNCHER_SKILL_ID } from '@/lib/agents/prerequisites';
import { DOCUMENTATION_REINDEX_VECTORS_AGENT_NAME } from '@/lib/agents/system/constants';

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
      'result quality with a small local LLM. Edit schedule or disable from ' +
      'the agents UI.',
    dispatch: 'internal',
    handlerKey: 'documentation-reindex-vectors',
    defaultSchedule: '16h',
    defaultModel: 'normal',
    prompt:
      'Auto-managed: refreshes the pgvector retrieval corpus for this project, ' +
      'wipes stale embeddings when the embedding model changes, and verifies ' +
      'result quality with a small local LLM. Edit schedule or disable from ' +
      'the agents UI.',
    skillIds: [],
    autoSeed: true,
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
    name: 'docs-generate',
    description: 'Generates one new doc page per run for an under-documented subsystem (architecture / concept / comparison / synthesis). Never edits existing docs.',
    dispatch: 'cli',
    defaultSchedule: '24h',
    defaultModel: 'smart',
    prompt: '',
    skillIds: ['agent-docs-generate'],
    tier: 'essential',
    fallbackEnabled: true,
    inspiration: [
      {
        label: "Karpathy's LLM Wiki Stack",
        url: 'https://github.com/ScrapingArt/Karpathy-LLM-Wiki-Stack',
      },
    ],
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
    name: 'improve',
    description: 'Audits the least-recently-modified source file and applies one safe, mechanical code-quality fix per run (TOCTOU collapse, parallel I/O, rotted-comment cleanup, dead try/catch, hot-path hoists). Verifies with type-check + the relevant vitest file.',
    dispatch: 'cli',
    defaultSchedule: '12h',
    defaultModel: 'normal',
    prompt: '',
    skillIds: ['agent-improve'],
    tier: 'featured',
    fallbackEnabled: true,
    inspiration: [
      {
        label: "Karpathy's coding guidelines (think first, simplicity, surgical changes, verifiable success)",
        url: 'https://github.com/multica-ai/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md',
      },
    ],
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
