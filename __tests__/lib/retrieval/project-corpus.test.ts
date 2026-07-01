import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS skills (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      content text NOT NULL DEFAULT '',
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL
    )
  `));
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      name text NOT NULL,
      project text NOT NULL,
      skill_ids text NOT NULL DEFAULT '[]',
      model text NOT NULL DEFAULT 'normal',
      prompt text NOT NULL DEFAULT '',
      schedule text,
      enabled boolean NOT NULL DEFAULT true,
      boostable boolean NOT NULL DEFAULT true,
      doc_paths text NOT NULL DEFAULT '[]',
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
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS projects (
      name text PRIMARY KEY,
      path text NOT NULL,
      enabled boolean DEFAULT false,
      github text,
      priority text,
      custom_actions text,
      test_command text,
      tests_disabled boolean DEFAULT false,
      review_disabled boolean DEFAULT false,
      test_cron_enabled boolean DEFAULT false,
      test_cron_schedule text,
      auto_commit_enabled boolean DEFAULT false,
      auto_push_enabled boolean DEFAULT false,
      auto_pr_merge_enabled boolean DEFAULT false,
      post_merge_watch_minutes integer DEFAULT 0,
      auto_revert_enabled boolean DEFAULT false,
      release_after_run boolean DEFAULT false,
      issue_auto_branch boolean DEFAULT true,
      last_push_error text,
      last_push_at double precision,
      review_prompt_addendum text,
      review_prerequisite_command text,
      fix_prompt_addendum text,
      website text,
      qa_url text,
      dev_server_start_command text,
      dev_server_stop_command text,
      dev_server_ready_url text,
      daily_spend_cap_usd double precision,
      release_spend_cap_usd double precision,
      setup_complete boolean NOT NULL DEFAULT false,
      setup_state text NOT NULL DEFAULT '{}',
      archived boolean NOT NULL DEFAULT false,
      paused boolean NOT NULL DEFAULT false
    )
  `));
}

describe('collectProjectRetrievalSources', () => {
  let sharedHandle: TestDbHandle;
  let projectPath: string;
  let listProjectDocumentsMock: ReturnType<typeof vi.fn>;
  let getBranchContextMock: ReturnType<typeof vi.fn>;
  let gitLsTreeSyncMock: ReturnType<typeof vi.fn>;

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
    vi.resetModules();
    await sharedHandle.db.execute(sql.raw('TRUNCATE settings, skills, agents, projects'));
    projectPath = mkdtempSync(join(tmpdir(), 'tamtam-project-corpus-'));
    mkdirSync(join(projectPath, '.tamtam', 'agents'), { recursive: true });
    listProjectDocumentsMock = vi.fn().mockReturnValue([]);
    getBranchContextMock = vi.fn().mockReturnValue({ isDefaultBranch: true, defaultBranch: 'master' });
    gitLsTreeSyncMock = vi.fn().mockReturnValue([]);
    vi.doMock('@/lib/db', () => ({ db: sharedHandle.db, schema }));
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
    vi.doUnmock('fs/promises');
    vi.resetModules();
  });

  async function importSubject() {
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

  it('indexes DB skills referenced by a project agent', async () => {
    const now = 1_700_000_000;
    await sharedHandle.db.insert(schema.skills).values([
      { id: 'skill-a', name: 'A', description: '', content: 'skill a', createdAt: now, updatedAt: now },
    ]).execute();
    await sharedHandle.db.insert(schema.agents).values({
      id: 'agent-qa',
      name: 'qa',
      project: 'myproject',
      skillIds: JSON.stringify(['skill-a']),
      model: 'normal',
      prompt: '',
      schedule: null,
      enabled: true,
      docPaths: JSON.stringify([]),
      provider: null,
      prerequisiteCommand: null,
      createdAt: now,
      updatedAt: now,
    }).execute();
    await sharedHandle.db.insert(schema.projects).values({ name: 'myproject', path: projectPath, enabled: true }).execute();

    const { collectProjectRetrievalSources } = await importSubject();
    const sources = await collectProjectRetrievalSources('myproject', projectPath);

    expect(sources.filter((source) => source.sourceKind === 'skill').map((source) => source.sourceId)).toEqual([
      'skill-a',
    ]);
  });

  it('ignores .tamtam/agents markdown files — agents are DB-only', async () => {
    const now = 1_700_000_000;
    writeFileSync(
      join(projectPath, '.tamtam', 'agents', 'qa.md'),
      `---\nskillIds: ["skill-from-file"]\n---\n\nRun checks.\n`
    );
    await sharedHandle.db.insert(schema.skills).values([
      { id: 'skill-from-db', name: 'DB Skill', description: '', content: 'from db', createdAt: now, updatedAt: now },
      { id: 'skill-from-file', name: 'File Skill', description: '', content: 'from file', createdAt: now, updatedAt: now },
    ]).execute();
    await sharedHandle.db.insert(schema.agents).values({
      id: 'agent-1',
      name: 'qa',
      project: 'myproject',
      skillIds: JSON.stringify(['skill-from-db']),
      model: 'normal',
      prompt: '',
      schedule: null,
      enabled: true,
      docPaths: JSON.stringify([]),
      provider: null,
      prerequisiteCommand: null,
      createdAt: now,
      updatedAt: now,
    }).execute();
    await sharedHandle.db.insert(schema.projects).values({ name: 'myproject', path: projectPath, enabled: true }).execute();

    const { collectProjectRetrievalSources } = await importSubject();
    const sources = await collectProjectRetrievalSources('myproject', projectPath);

    expect(sources.filter((source) => source.sourceKind === 'skill').map((source) => source.sourceId).sort()).toEqual([
      'skill-from-db',
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
    await sharedHandle.db.insert(schema.projects).values({ name: 'myproject', path: projectPath, enabled: true }).execute();

    const { collectProjectRetrievalSources } = await importSubject();
    const sources = await collectProjectRetrievalSources('myproject', projectPath);

    expect(listProjectDocumentsMock).toHaveBeenCalledWith(projectPath, { includeAgentDocs: false });
    expect(
      sources
        .filter((source) => source.sourceKind === 'project_doc')
        .map((source) => source.sourceId)
    ).toEqual(['README.md']);
  });

  it('skips a project doc that disappears before indexing opens it', async () => {
    const readmePath = join(projectPath, 'README.md');
    writeFileSync(readmePath, '# README\n\nTransient docs.\n');
    listProjectDocumentsMock.mockImplementation(() => {
      rmSync(readmePath, { force: true });
      return [readmePath];
    });
    await sharedHandle.db.insert(schema.projects).values({ name: 'myproject', path: projectPath, enabled: true }).execute();

    const { collectProjectRetrievalSources } = await importSubject();
    const sources = await collectProjectRetrievalSources('myproject', projectPath);

    expect(sources.filter((source) => source.sourceKind === 'project_doc')).toEqual([]);
  });

  it('reads project documents without opening them all concurrently', async () => {
    let activeHandles = 0;
    let maxActiveHandles = 0;
    const docPaths = ['README.md', 'docs/one.md', 'docs/two.md'].map((path) => join(projectPath, path));
    const openMock = vi.fn(async (filePath: string) => {
      activeHandles += 1;
      maxActiveHandles = Math.max(maxActiveHandles, activeHandles);
      return {
        readFile: vi.fn(async () => `# ${filePath}`),
        stat: vi.fn(async () => ({ mtimeMs: 1_700_000_000_000 })),
        close: vi.fn(async () => {
          activeHandles -= 1;
        }),
      };
    });
    vi.doMock('fs/promises', async () => {
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      return {
        ...actual,
        open: openMock,
      };
    });
    listProjectDocumentsMock.mockReturnValue(docPaths);
    await sharedHandle.db.insert(schema.projects).values({ name: 'myproject', path: projectPath, enabled: true }).execute();

    const { collectProjectRetrievalSources } = await importSubject();
    const sources = await collectProjectRetrievalSources('myproject', projectPath);

    expect(openMock).toHaveBeenCalledTimes(docPaths.length);
    expect(maxActiveHandles).toBe(1);
    expect(activeHandles).toBe(0);
    expect(sources.filter((source) => source.sourceKind === 'project_doc').map((source) => source.sourceId)).toEqual([
      'README.md',
      'docs/one.md',
      'docs/two.md',
    ]);
  });
});
