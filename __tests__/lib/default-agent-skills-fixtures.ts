import { expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

export function sha256Prefix(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// Hoisted ref the module-scope vi.mock factory closes over. We swap in the
// real PGlite-backed db once beforeAll has built it. Hoisting the mock keeps
// `vi.resetModules()` cheap — we only re-evaluate the seed module itself
// (to reset its module-level `seeded` guard), not the db module.
const dbRef = vi.hoisted(() => ({ db: null as unknown as TestDbHandle['db'] }));

vi.mock('@/lib/db', async () => {
  const schemaModule = await import('@/lib/db/schema');
  return { db: dbRef.db, schema: schemaModule };
});

export let sharedDefaultAgentSkillsHandle: TestDbHandle;

async function applyDdl(h: TestDbHandle): Promise<void> {
  // PGlite only accepts one CREATE per execute call.
  await h.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS skills (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      content text NOT NULL DEFAULT '',
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
  await h.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      name text NOT NULL,
      project text NOT NULL,
      skill_ids text NOT NULL DEFAULT '[]',
      doc_paths text NOT NULL DEFAULT '[]',
      model text NOT NULL DEFAULT 'sonnet',
      prompt text NOT NULL DEFAULT '',
      schedule text,
      enabled boolean NOT NULL DEFAULT true,
      boostable boolean NOT NULL DEFAULT true,
      provider text,
      fallback_enabled boolean NOT NULL DEFAULT false,
      prerequisite_command text,
      permission_mode text,
      kind text NOT NULL DEFAULT 'user',
      role text NOT NULL DEFAULT 'producer',
      autopilot_state text,
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
}

beforeAll(async () => {
  sharedDefaultAgentSkillsHandle = await createTestPgDbEmpty();
  await applyDdl(sharedDefaultAgentSkillsHandle);
  // Wire the module-scope mock factory's reference now that the db exists.
  dbRef.db = sharedDefaultAgentSkillsHandle.db;
});

afterAll(async () => {
  try {
    await sharedDefaultAgentSkillsHandle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

export async function selectAllSkills() {
  return sharedDefaultAgentSkillsHandle.db.select().from(schema.skills);
}

export async function selectAllAgents() {
  return sharedDefaultAgentSkillsHandle.db.select().from(schema.agents);
}

export async function findSkill(id: string) {
  const rows = await selectAllSkills();
  return rows.find((s) => s.id === id);
}

export async function findAgent(id: string) {
  const rows = await selectAllAgents();
  return rows.find((a) => a.id === id);
}

// Total number of default skills in lib/agents/default-agent-skills.ts.
// Used as the strict drain target so we know every fire-and-forget seed write
// has landed without needing a wall-clock sleep tail.
const DEFAULT_SKILL_COUNT = 17;

// seedDefaultSkills() is sync but kicks off `void db.select().then(insert|update)`
// fire-and-forget chains for every default skill. Wait until exactly
// DEFAULT_SKILL_COUNT default skill rows are present — that proves every insert
// settled. Tests that mutate updates of pre-existing rows use vi.waitFor on
// their own assertion to handle the update race.
export async function waitForSeedToSettle(): Promise<void> {
  await vi.waitFor(async () => {
    const rows = await selectAllSkills();
    const defaultRows = rows.filter((s) => s.id.startsWith('agent-'));
    expect(defaultRows.length).toBeGreaterThanOrEqual(DEFAULT_SKILL_COUNT);
  }, { timeout: 5000, interval: 1 });
}

// Fast-polling vi.waitFor wrapper. Default vi.waitFor interval is 10ms, but
// the work we wait on (a single drizzle update) typically lands within a
// microtask or two. Use a 1ms interval to keep retry overhead out of the
// per-test budget while still giving real failures a 5s ceiling.
export async function waitForFast(cb: () => unknown | Promise<unknown>): Promise<void> {
  await vi.waitFor(cb, { timeout: 5000, interval: 1 });
}

export async function resetSeedModuleAndTables(): Promise<typeof import('@/lib/agents/default-agent-skills').seedDefaultSkills> {
  // Reset the seed module's `seeded` guard. The module-scope vi.mock for
  // `@/lib/db` survives this — only the seed module itself re-evaluates.
  vi.resetModules();
  // Drain any fire-and-forget seed writes from the prior test before we wipe
  // the tables. TRUNCATE racing against a pending insert would leak rows into
  // the next case.
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setImmediate(r));
  }
  await sharedDefaultAgentSkillsHandle.db.execute(sql.raw('TRUNCATE skills, agents'));
  const mod = await import('@/lib/agents/default-agent-skills');
  return mod.seedDefaultSkills;
}

