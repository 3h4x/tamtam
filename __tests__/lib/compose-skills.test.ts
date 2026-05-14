import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';
import * as schema from '@/lib/db/schema';

async function applyDdl(h: TestDbHandle): Promise<void> {
  // PGlite rejects multi-statement prepared queries: each CREATE TABLE must be
  // its own db.execute call.
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
}

describe('composeAgentSkills', () => {
  let sharedHandle: TestDbHandle;
  // Back-compat shim so existing test bodies referencing `handle.db` work.
  const handle = { get db() { return sharedHandle.db; } } as { db: TestDbHandle['db'] };
  let tempDir: string;
  let skillsDir: string;
  let dataSkillsDir: string;
  let composeAgentSkills: typeof import('@/lib/agents/compose-skills').composeAgentSkills;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 30));
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-compose-skills-'));
    skillsDir = join(tempDir, 'skills');
    dataSkillsDir = join(tempDir, 'data-skills');
    mkdirSync(join(skillsDir, 'docs', 'skills', 'engineering'), { recursive: true });
    mkdirSync(join(dataSkillsDir, 'custom'), { recursive: true });
    mkdirSync(join(tempDir, 'project', 'docs'), { recursive: true });

    await sharedHandle.db.execute(sql.raw('TRUNCATE skills'));

    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
    vi.doMock('@/lib/skills/skills', () => ({
      SKILLS_DIR: skillsDir,
      DATA_SKILLS_DIR: dataSkillsDir,
    }));

    ({ composeAgentSkills } = await import('@/lib/agents/compose-skills'));
  });

  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('composes requested docs, DB skills, and persona files in the expected order', async () => {
    await handle.db.insert(schema.skills).values({
      id: 'db-skill-1',
      name: 'DB Skill',
      description: 'database description',
      content: 'Use the real db skill.',
      createdAt: 1,
      updatedAt: 1,
    });

    writeFileSync(join(tempDir, 'project', 'docs', 'plan.md'), 'Follow the release checklist.');
    writeFileSync(
      join(skillsDir, 'docs', 'skills', 'engineering', 'reviewer.md'),
      `---
name: Senior Reviewer
---
Review recent changes carefully.`,
    );
    writeFileSync(
      join(dataSkillsDir, 'custom', 'writer.md'),
      '# Team Writer\n\nProduce concise docs updates.',
    );

    const composed = await composeAgentSkills(
      join(tempDir, 'project'),
      ['db-skill-1', 'persona:engineering/reviewer', 'persona:custom/writer'],
      ['docs/plan.md'],
    );

    expect(composed.docParts).toEqual([
      '## plan.md\nFollow the release checklist.',
    ]);
    expect(composed.parts).toEqual([
      '## DB Skill\nUse the real db skill.',
      `---
name: Senior Reviewer
---
Review recent changes carefully.`,
      '# Team Writer\n\nProduce concise docs updates.',
    ]);
    expect(composed.metaDocs).toEqual([
      { name: 'plan.md', path: 'docs/plan.md' },
    ]);
    expect(composed.metaSkills).toEqual([
      {
        id: 'db-skill-1',
        name: 'DB Skill',
        description: 'database description',
        content: 'Use the real db skill.',
        source: 'db',
      },
      {
        id: 'persona:engineering/reviewer',
        name: 'Senior Reviewer',
        description: 'engineering/reviewer',
        source: 'file',
      },
      {
        id: 'persona:custom/writer',
        name: 'Team Writer',
        description: 'custom/writer',
        source: 'file',
      },
    ]);
  });

  it('ignores doc paths outside the project root', async () => {
    writeFileSync(join(tempDir, 'outside.md'), 'should stay out');

    const composed = await composeAgentSkills(
      join(tempDir, 'project'),
      [],
      ['../outside.md', 'docs/missing.md'],
    );

    expect(composed.docParts).toEqual([]);
    expect(composed.metaDocs).toEqual([]);
  });

  it('keeps fallback metadata for missing persona files without adding prompt content', async () => {
    const composed = await composeAgentSkills(
      join(tempDir, 'project'),
      ['persona:engineering/missing-skill'],
      [],
    );

    expect(composed.parts).toEqual([]);
    expect(composed.metaSkills).toEqual([
      {
        id: 'persona:engineering/missing-skill',
        name: 'missing-skill',
        description: 'engineering/missing-skill',
        source: 'file',
      },
    ]);
  });
});
