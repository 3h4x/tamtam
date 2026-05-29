import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { SKILLS_DIR } from '@/lib/skills/skills';

// File-based default-agent skills live under `skills/docs/skills/tamtam/`,
// reusing the persona-skills directory tree so they ship in the same git
// surface and get the same defense-in-depth path checks.
//
// Frontmatter carries everything BUT the prompt body. The split:
//   - Required: id, name, description (catalog identity).
//   - Optional `agent:` block: defaultSchedule, defaultModel, tier,
//     fallbackEnabled, aliases — these override the inline catalog entry
//     in `lib/agents/catalog.ts` for the matching `skillIds[0]`.
//   - Optional `references:` (label+url list): inspiration / source
//     material — surfaced in the catalog UI, NOT injected into the LLM
//     prompt. Keeping these out of the body saves cache-read tokens on
//     every tool turn.
//   - Optional `requires:` (string list): preconditions — surfaced in UI
//     so users know what the agent expects to find.
//   - Optional `outputs:` (string list): artifacts the run produces.
//   - Optional `relatedAgents:` (string list): UI "see also" hints.
//
// Long prompts (e.g. `agent:improve`) belong here — TS template literals
// are awkward at that length (escape noise, no syntax highlighting, hard to
// diff). Short prompts can stay inline in `default-agent-skills.ts`.
//
// Boot risk vs locality: the loader asserts every file has the required
// frontmatter and that IDs are unique. A missing/renamed file simply means
// that ID stops appearing in `DEFAULT_AGENT_SKILLS` — the boot assertion
// in `default-agent-skills.ts` then refuses to start the server if any
// catalog entry references an unknown skill ID. Fail-loud is the
// deliberate trade for keeping metadata + content in one file.

const TAMTAM_SKILLS_DIR = join(SKILLS_DIR, 'docs', 'skills', 'tamtam');

export interface FileBackedAgentDefaults {
  defaultSchedule?: string;
  defaultModel?: string;
  tier?: 'essential' | 'featured' | 'recommended';
  fallbackEnabled?: boolean;
  aliases?: string[];
}

export interface FileBackedReference {
  label: string;
  url: string;
}

export interface FileBackedSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  /** Prompt-content version, e.g. "1", "2026-05-29", "1.2.0". Optional;
   *  when present the audit log can show which prompt version produced
   *  each row, and a bump invalidates prior "clean" audit entries so the
   *  agent re-evaluates files under the new rubric. */
  version?: string;
  /** Shell command run before the LLM turn starts; stdout is injected
   *  into the prompt. May contain `{{project}}` as a placeholder for
   *  the URL-encoded project name (substituted server-side). When
   *  omitted, the agent has no default prerequisite. */
  prerequisite?: string;
  agentDefaults?: FileBackedAgentDefaults;
  references?: FileBackedReference[];
  requires?: string[];
  outputs?: string[];
  relatedAgents?: string[];
}

interface ParsedFrontmatter {
  fm: Record<string, unknown>;
  body: string;
}

function splitFrontmatter(text: string, source: string): ParsedFrontmatter {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n([\s\S]*))?$/);
  if (!match) {
    throw new Error(`[tamtam-file-skills] ${source}: missing YAML frontmatter block (must start with --- and end with ---)`);
  }
  const body = (match[2] ?? '').trim();
  if (!body) {
    throw new Error(`[tamtam-file-skills] ${source}: skill body is empty`);
  }
  let fm: unknown;
  try {
    fm = parseYaml(match[1]);
  } catch (err) {
    throw new Error(`[tamtam-file-skills] ${source}: invalid YAML frontmatter — ${(err as Error).message}`, { cause: err });
  }
  if (fm == null || typeof fm !== 'object' || Array.isArray(fm)) {
    throw new Error(`[tamtam-file-skills] ${source}: frontmatter must parse to a mapping`);
  }
  return { fm: fm as Record<string, unknown>, body };
}

function requireString(fm: Record<string, unknown>, key: string, source: string): string {
  const v = fm[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`[tamtam-file-skills] ${source}: frontmatter is missing required string field "${key}"`);
  }
  return v.trim();
}

function optionalStringList(value: unknown, key: string, source: string): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`[tamtam-file-skills] ${source}: frontmatter field "${key}" must be a list of strings`);
  }
  return value.map((item, i) => {
    if (typeof item !== 'string') {
      throw new Error(`[tamtam-file-skills] ${source}: ${key}[${i}] must be a string`);
    }
    return item.trim();
  }).filter(Boolean);
}

function optionalReferences(value: unknown, source: string): FileBackedReference[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`[tamtam-file-skills] ${source}: "references" must be a list of {label, url}`);
  }
  return value.map((item, i) => {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`[tamtam-file-skills] ${source}: references[${i}] must be {label, url}`);
    }
    const obj = item as Record<string, unknown>;
    const label = typeof obj.label === 'string' ? obj.label.trim() : '';
    const url = typeof obj.url === 'string' ? obj.url.trim() : '';
    if (!label || !url) {
      throw new Error(`[tamtam-file-skills] ${source}: references[${i}] needs non-empty "label" and "url"`);
    }
    return { label, url };
  });
}

function optionalAgentDefaults(value: unknown, source: string): FileBackedAgentDefaults | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[tamtam-file-skills] ${source}: "agent" must be a mapping`);
  }
  const obj = value as Record<string, unknown>;
  const out: FileBackedAgentDefaults = {};
  if (obj.defaultSchedule != null) {
    if (typeof obj.defaultSchedule !== 'string') throw new Error(`[tamtam-file-skills] ${source}: agent.defaultSchedule must be a string`);
    out.defaultSchedule = obj.defaultSchedule.trim();
  }
  if (obj.defaultModel != null) {
    if (typeof obj.defaultModel !== 'string') throw new Error(`[tamtam-file-skills] ${source}: agent.defaultModel must be a string`);
    out.defaultModel = obj.defaultModel.trim();
  }
  if (obj.tier != null) {
    if (obj.tier !== 'essential' && obj.tier !== 'featured' && obj.tier !== 'recommended') {
      throw new Error(`[tamtam-file-skills] ${source}: agent.tier must be one of essential | featured | recommended`);
    }
    out.tier = obj.tier;
  }
  if (obj.fallbackEnabled != null) {
    if (typeof obj.fallbackEnabled !== 'boolean') throw new Error(`[tamtam-file-skills] ${source}: agent.fallbackEnabled must be a boolean`);
    out.fallbackEnabled = obj.fallbackEnabled;
  }
  if (obj.aliases != null) {
    out.aliases = optionalStringList(obj.aliases, 'agent.aliases', source) ?? [];
  }
  return out;
}

let cache: FileBackedSkill[] | null = null;
let indexByIdCache: Map<string, FileBackedSkill> | null = null;

export function loadTamTamFileSkills(): FileBackedSkill[] {
  if (cache) return cache;
  let entries: string[];
  try {
    entries = readdirSync(/*turbopackIgnore: true*/ TAMTAM_SKILLS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = [];
      indexByIdCache = new Map();
      return cache;
    }
    throw err;
  }
  const skills: FileBackedSkill[] = [];
  const seen = new Set<string>();
  for (const fname of entries.sort()) {
    if (!fname.endsWith('.md')) continue;
    const full = join(TAMTAM_SKILLS_DIR, fname);
    const raw = readFileSync(/*turbopackIgnore: true*/ full, 'utf-8');
    const { fm, body } = splitFrontmatter(raw, fname);
    const id = requireString(fm, 'id', fname);
    const name = requireString(fm, 'name', fname);
    const description = requireString(fm, 'description', fname);
    if (seen.has(id)) {
      throw new Error(`[tamtam-file-skills] duplicate skill id "${id}" (second occurrence in ${fname})`);
    }
    seen.add(id);
    // Coerce version: YAML auto-parses bare `1` as a number, `2026-05-29`
    // as a Date. Stringify everything so downstream consumers see the
    // author's literal token without surprises.
    let version: string | undefined;
    if (fm.version != null) {
      if (typeof fm.version === 'string') version = fm.version.trim();
      else if (typeof fm.version === 'number') version = String(fm.version);
      else if (fm.version instanceof Date) version = fm.version.toISOString().slice(0, 10);
      else throw new Error(`[tamtam-file-skills] ${fname}: "version" must be a string, number, or YYYY-MM-DD date`);
    }
    let prerequisite: string | undefined;
    if (fm.prerequisite != null) {
      if (typeof fm.prerequisite !== 'string') {
        throw new Error(`[tamtam-file-skills] ${fname}: "prerequisite" must be a string (shell command)`);
      }
      const trimmed = fm.prerequisite.trim();
      if (trimmed) prerequisite = trimmed;
    }
    skills.push({
      id,
      name,
      description,
      content: body,
      version,
      prerequisite,
      agentDefaults: optionalAgentDefaults(fm.agent, fname),
      references: optionalReferences(fm.references, fname),
      requires: optionalStringList(fm.requires, 'requires', fname),
      outputs: optionalStringList(fm.outputs, 'outputs', fname),
      relatedAgents: optionalStringList(fm.relatedAgents, 'relatedAgents', fname),
    });
  }
  cache = skills;
  indexByIdCache = new Map(skills.map((s) => [s.id, s]));
  return cache;
}

export function findFileBackedSkill(id: string): FileBackedSkill | null {
  if (!indexByIdCache) loadTamTamFileSkills();
  return indexByIdCache?.get(id) ?? null;
}

// Test-only: clear the cache so a test that creates a fresh skills dir
// (e.g. via a temp filesystem) can force a fresh read.
export function _resetFileSkillsCacheForTests(): void {
  cache = null;
  indexByIdCache = null;
}
