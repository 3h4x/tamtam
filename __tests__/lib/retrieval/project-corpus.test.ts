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
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT NOT NULL,
      skill_ids TEXT NOT NULL DEFAULT '[]',
      model TEXT NOT NULL DEFAULT 'normal',
      prompt TEXT NOT NULL DEFAULT '',
      schedule TEXT,
      runner TEXT NOT NULL DEFAULT 'pm2',
      enabled INTEGER NOT NULL DEFAULT 1,
      doc_paths TEXT NOT NULL DEFAULT '[]',
      provider TEXT,
      prerequisite_command TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      github TEXT,
      priority TEXT,
      custom_actions TEXT,
      test_command TEXT,
      tests_disabled INTEGER DEFAULT 0,
      review_disabled INTEGER DEFAULT 0,
      test_cron_enabled INTEGER DEFAULT 0,
      test_cron_schedule TEXT,
      auto_commit_enabled INTEGER DEFAULT 0,
      auto_push_enabled INTEGER DEFAULT 0,
      auto_pr_merge_enabled INTEGER DEFAULT 0,
      release_after_run INTEGER DEFAULT 0,
      issue_auto_branch INTEGER DEFAULT 1,
      last_push_error TEXT,
      last_push_at REAL,
      review_prompt_addendum TEXT,
      fix_prompt_addendum TEXT,
      website TEXT,
      qa_url TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('collectProjectRetrievalSources', () => {
  let projectPath: string;
  let testDb: ReturnType<typeof createTestDb>;
  let listProjectDocumentsMock: ReturnType<typeof vi.fn>;
  let getBranchContextMock: ReturnType<typeof vi.fn>;
  let gitLsTreeSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    projectPath = mkdtempSync(join(tmpdir(), 'tamtam-project-corpus-'));
    mkdirSync(join(projectPath, '.tamtam', 'agents'), { recursive: true });
    testDb = createTestDb();
    listProjectDocumentsMock = vi.fn().mockReturnValue([]);
    getBranchContextMock = vi.fn().mockReturnValue({ isDefaultBranch: true, defaultBranch: 'master' });
    gitLsTreeSyncMock = vi.fn().mockReturnValue([]);
  });

  afterEach(() => {
    testDb.sqlite.close();
    rmSync(projectPath, { recursive: true, force: true });
    vi.resetModules();
  });

  async function importSubject() {
    vi.doMock('@/lib/db', () => ({ db: testDb.db, schema }));
    vi.doMock('@/lib/shared/project-documents', () => ({
      listProjectDocuments: listProjectDocumentsMock,
    }));
    vi.doMock('@/lib/git/git-branch', () => ({
      getBranchContext: getBranchContextMock,
      gitLsTreeSync: gitLsTreeSyncMock,
      gitShowSync: vi.fn(),
    }));
    return import('@/lib/agents/retrieval/project-corpus');
  }

  it('indexes DB skills referenced by file agents after file-agent overrides are applied', async () => {
    const now = 1_700_000_000;
    writeFileSync(
      join(projectPath, '.tamtam', 'agents', 'qa.md'),
      `---\nskillIds: ["skill-from-file"]\n---\n\nRun checks.\n`
    );
    await testDb.db.insert(schema.skills).values([
      { id: 'skill-from-file', name: 'File Skill', description: '', content: 'from file', createdAt: now, updatedAt: now },
      { id: 'skill-from-override', name: 'Override Skill', description: '', content: 'from override', createdAt: now, updatedAt: now },
    ]).execute();
    await testDb.db.insert(schema.settings).values({
      key: 'agent_override:myproject:qa',
      value: JSON.stringify({ skillIds: ['skill-from-override'] }),
    }).execute();
    await testDb.db.insert(schema.projects).values({ name: 'myproject', path: projectPath, enabled: true }).execute();

    const { collectProjectRetrievalSources } = await importSubject();
    const sources = await collectProjectRetrievalSources('myproject', projectPath);

    expect(sources.filter((source) => source.sourceKind === 'skill').map((source) => source.sourceId)).toEqual([
      'skill-from-override',
    ]);
  });

  it('excludes file-agent skills when a DB agent with the same name takes precedence', async () => {
    const now = 1_700_000_000;
    writeFileSync(
      join(projectPath, '.tamtam', 'agents', 'qa.md'),
      `---\nskillIds: ["skill-from-file"]\n---\n\nRun checks.\n`
    );
    await testDb.db.insert(schema.skills).values([
      { id: 'skill-from-db', name: 'DB Skill', description: '', content: 'from db', createdAt: now, updatedAt: now },
      { id: 'skill-from-file', name: 'File Skill', description: '', content: 'from file', createdAt: now, updatedAt: now },
      { id: 'skill-from-other-file-agent', name: 'Other File Skill', description: '', content: 'from other file agent', createdAt: now, updatedAt: now },
    ]).execute();
    await testDb.db.insert(schema.agents).values({
      id: 'agent-1',
      name: 'qa',
      project: 'myproject',
      skillIds: JSON.stringify(['skill-from-db']),
      model: 'normal',
      prompt: '',
      schedule: null,
      runner: 'pm2',
      enabled: true,
      docPaths: JSON.stringify([]),
      provider: null,
      prerequisiteCommand: null,
      createdAt: now,
      updatedAt: now,
    }).execute();
    writeFileSync(
      join(projectPath, '.tamtam', 'agents', 'docs.md'),
      `---\nskillIds: ["skill-from-other-file-agent"]\n---\n\nSync docs.\n`
    );
    await testDb.db.insert(schema.projects).values({ name: 'myproject', path: projectPath, enabled: true }).execute();

    const { collectProjectRetrievalSources } = await importSubject();
    const sources = await collectProjectRetrievalSources('myproject', projectPath);

    expect(sources.filter((source) => source.sourceKind === 'skill').map((source) => source.sourceId).sort()).toEqual([
      'skill-from-db',
      'skill-from-other-file-agent',
    ]);
  });

  it('does not index working-tree file-agent markdown as project docs on non-default branches', async () => {
    const readmePath = join(projectPath, 'README.md');
    const fileAgentPath = join(projectPath, '.tamtam', 'agents', 'qa.md');
    writeFileSync(readmePath, '# README\n\nTrusted docs.\n');
    writeFileSync(fileAgentPath, 'working tree agent prompt');
    listProjectDocumentsMock.mockImplementation((_projectPath: string, opts?: { includeAgentDocs?: boolean }) => {
      if (opts?.includeAgentDocs === false) {
        return [readmePath];
      }
      return [readmePath, fileAgentPath];
    });
    getBranchContextMock.mockReturnValue({ isDefaultBranch: false, defaultBranch: 'master' });
    await testDb.db.insert(schema.projects).values({ name: 'myproject', path: projectPath, enabled: true }).execute();

    const { collectProjectRetrievalSources } = await importSubject();
    const sources = await collectProjectRetrievalSources('myproject', projectPath);

    expect(listProjectDocumentsMock).toHaveBeenCalledWith(projectPath, { includeAgentDocs: false });
    expect(
      sources
        .filter((source) => source.sourceKind === 'project_doc')
        .map((source) => source.sourceId)
    ).toEqual(['README.md']);
  });
});
