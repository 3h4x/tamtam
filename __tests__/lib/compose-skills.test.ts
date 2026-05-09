import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as schema from '@/lib/db/schema';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
  `);

  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('composeAgentSkills', () => {
  let tempDir: string;
  let skillsDir: string;
  let dataSkillsDir: string;
  let testDb: ReturnType<typeof createTestDb>;
  let composeAgentSkills: typeof import('@/lib/agents/compose-skills').composeAgentSkills;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-compose-skills-'));
    skillsDir = join(tempDir, 'skills');
    dataSkillsDir = join(tempDir, 'data-skills');
    mkdirSync(join(skillsDir, 'docs', 'skills', 'engineering'), { recursive: true });
    mkdirSync(join(dataSkillsDir, 'custom'), { recursive: true });
    mkdirSync(join(tempDir, 'project', 'docs'), { recursive: true });

    testDb = createTestDb();
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/skills/skills', () => ({
      SKILLS_DIR: skillsDir,
      DATA_SKILLS_DIR: dataSkillsDir,
    }));

    ({ composeAgentSkills } = await import('@/lib/agents/compose-skills'));
  });

  afterEach(() => {
    vi.resetModules();
    testDb.sqlite.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('composes requested docs, DB skills, and persona files in the expected order', () => {
    testDb.sqlite
      .prepare('INSERT INTO skills (id, name, description, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('db-skill-1', 'DB Skill', 'database description', 'Use the real db skill.', 1, 1);

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

    const composed = composeAgentSkills(
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

  it('ignores doc paths outside the project root', () => {
    writeFileSync(join(tempDir, 'outside.md'), 'should stay out');

    const composed = composeAgentSkills(
      join(tempDir, 'project'),
      [],
      ['../outside.md', 'docs/missing.md'],
    );

    expect(composed.docParts).toEqual([]);
    expect(composed.metaDocs).toEqual([]);
  });

  it('keeps fallback metadata for missing persona files without adding prompt content', () => {
    const composed = composeAgentSkills(
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
