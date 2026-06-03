import { AGENT_CATALOG } from '@/lib/agents/catalog';
import {
  hasIssueCruncherSkill,
  normalizeStoredPrerequisiteCommand,
} from '@/lib/agents/prerequisites';
import { resolveAgentPrerequisiteCommandWithFileSkills } from '@/lib/agents/file-skill-prerequisites';
import { loadTamTamFileSkills } from '@/lib/agents/skills-from-files';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';

interface DefaultSkill {
  id: string;
  name: string;
  description: string;
  content: string;
}

// All default-agent skills live as markdown files under
// `skills/docs/skills/tamtam/` with YAML frontmatter. The loader at
// `lib/agents/skills-from-files.ts` is the single source of truth.
// Each .md file owns its own id/name/description/version, the prompt
// body, and (when the skill backs a built-in agent) the agent-template
// defaults that override `lib/agents/catalog.ts`.

// Matches the auto-generated issue-cruncher prerequisite URL from prior versions
// (currently: `…/issues?trusted_only=1`). Used to migrate stored prereq commands
// from older builds to the current shape without overwriting user-customised ones.
const LEGACY_ISSUE_CRUNCHER_PREREQ_RE =
  /^curl -fsS "http:\/\/localhost:1337\/api\/projects\/by-project\/[^"]+\/issues\?trusted_only=1"$/;

export async function backfillIssueCruncherPrerequisites(): Promise<void> {
  const agents = await db.select().from(schema.agents);
  for (const agent of agents) {
    let skillIds: string[] = [];
    try {
      skillIds = JSON.parse(agent.skillIds || '[]');
    } catch {
      continue;
    }
    if (!hasIssueCruncherSkill(skillIds)) continue;
    const stored = normalizeStoredPrerequisiteCommand(agent.prerequisiteCommand);
    const target = resolveAgentPrerequisiteCommandWithFileSkills({
      project: agent.project,
      skillIds,
      prerequisiteCommand: null,
    });
    if (!target) continue;
    // Backfill empty rows. Also overwrite legacy auto-generated URLs so the
    // hardened endpoint replaces the older slim-list path on the next run.
    // User-customised commands (anything not matching the legacy regex) are left alone.
    const needsBackfill = stored === null;
    const needsMigration = typeof stored === 'string' && LEGACY_ISSUE_CRUNCHER_PREREQ_RE.test(stored) && stored !== target;
    if (!needsBackfill && !needsMigration) continue;
    void db.update(schema.agents)
      .set({
        prerequisiteCommand: target,
        updatedAt: Date.now() / 1000,
      })
      .where(eq(schema.agents.id, agent.id))
      .execute()
      .catch((e) => console.error('[default-agent-skills] backfill update failed:', e));
  }
}

// Build the content the LLM will see for a file-backed skill: we prepend
// a minimal "Prompt metadata" header carrying the version so the agent
// can copy it into its audit log without re-reading the .md file.
// Everything else from the frontmatter (agent.*, references, requires,
// outputs, relatedAgents) is metadata for the catalog/UI and stays OUT
// of the prompt body — putting it in the prompt would waste cache-read
// tokens on every tool turn.
function buildFileSkillContent(skill: { content: string; version?: string }): string {
  if (!skill.version) return skill.content;
  return `<!-- Prompt version: ${skill.version} (use this exact string when appending to your audit log) -->\n\n${skill.content}`;
}

// Merge inline + file-backed skills. Duplicate IDs fail loud so a stray
// re-introduction of an inline entry that's been moved to markdown (or
// vice versa) breaks the build instead of silently shadowing the other.
const DEFAULT_AGENT_SKILLS: DefaultSkill[] = (() => {
  const merged: DefaultSkill[] = loadTamTamFileSkills().map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    content: buildFileSkillContent(s),
  }));
  const seen = new Set<string>();
  for (const s of merged) {
    if (seen.has(s.id)) {
      throw new Error(`[default-agent-skills] duplicate skill id "${s.id}" in skills/docs/skills/tamtam/`);
    }
    seen.add(s.id);
  }
  return merged;
})();

let seeded = false;

export function seedDefaultSkills(): void {
  if (seeded) return;
  seeded = true;
  const now = Date.now() / 1000;
  for (const skill of DEFAULT_AGENT_SKILLS) {
    void db.select().from(schema.skills).where(eq(schema.skills.id, skill.id)).limit(1).then((rows) => {
      const existing = rows[0] ?? null;
      if (!existing) {
        return db.insert(schema.skills).values({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          content: skill.content,
          createdAt: now,
          updatedAt: now,
        }).execute();
      } else {
        // Default skills are not user-editable via /skills (see
        // /api/skills/[skillId] PATCH/DELETE guards). Always overwrite content
        // and description on boot so improvements roll out everywhere.
        return db.update(schema.skills)
          .set({ content: skill.content, description: skill.description, updatedAt: now })
          .where(eq(schema.skills.id, skill.id))
          .execute();
      }
    }).catch((e) => console.error('[default-agent-skills] seed failed for', skill.id, e));
  }
  void backfillIssueCruncherPrerequisites()
    .catch((e) => console.error('[default-agent-skills] backfill failed:', e));
}

const DEFAULT_SKILL_ID_SET: ReadonlySet<string> = new Set(
  DEFAULT_AGENT_SKILLS.map(s => s.id),
);

export function isDefaultSkillId(id: string): boolean {
  return DEFAULT_SKILL_ID_SET.has(id);
}

// Boot-time integrity check: every skill ID referenced by the agent
// catalog must resolve to a real default skill (inline OR file-backed)
// or be a `persona:` reference (resolved at runtime by compose-skills).
// A missing reference would silently ship an empty prompt — which we'd
// rather discover at server start than at the first scheduled agent run.
(function assertCatalogSkillsResolve() {
  const missing: Array<{ agent: string; skillId: string }> = [];
  for (const entry of AGENT_CATALOG) {
    for (const id of entry.skillIds) {
      if (id.startsWith('persona:')) continue;
      if (!DEFAULT_SKILL_ID_SET.has(id)) {
        missing.push({ agent: entry.name, skillId: id });
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[default-agent-skills] catalog references unknown skills (fix lib/agents/catalog.ts or add the skill to inline list / skills/docs/skills/tamtam/): ${missing
        .map((m) => `${m.agent} → ${m.skillId}`)
        .join(', ')}`,
    );
  }
})();
