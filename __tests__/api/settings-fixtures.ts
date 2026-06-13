import { beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createTestPgDbEmpty, type TestDbHandle } from '@/__tests__/helpers/test-db';

const hoisted = vi.hoisted(() => ({
  dbRef: { current: null as unknown as TestDbHandle['db'] },
  syncJobsPauseStateMock: vi.fn(),
  ensureProjectBoardMock: vi.fn(),
}));

const { dbRef } = hoisted;
export const { syncJobsPauseStateMock, ensureProjectBoardMock } = hoisted;

vi.mock('@/lib/db', () => ({
  get db() {
    return dbRef.current;
  },
  schema,
}));

vi.mock('@/lib/shared/job-control', () => ({
  syncJobsPauseState: syncJobsPauseStateMock,
}));

vi.mock('@/lib/github/project-board', () => ({
  ensureProjectBoard: ensureProjectBoardMock,
}));

type SettingsRoute = typeof import('@/app/api/settings/route');

async function applyDdl(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `));
}

export function setupSettingsApiTest() {
  let sharedHandle: TestDbHandle;
  let GET: SettingsRoute['GET'];
  let PATCH: SettingsRoute['PATCH'];
  let reloadConfig: () => void;

  beforeAll(async () => {
    sharedHandle = await createTestPgDbEmpty();
    await applyDdl(sharedHandle);
    dbRef.current = sharedHandle.db;
    const [routeMod, configMod] = await Promise.all([
      import('@/app/api/settings/route'),
      import('@/lib/shared/config'),
    ]);
    GET = routeMod.GET;
    PATCH = routeMod.PATCH;
    reloadConfig = configMod.reloadConfig;
  });

  afterAll(async () => {
    try {
      await sharedHandle[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    await sharedHandle.db.execute(sql.raw('TRUNCATE settings'));

    syncJobsPauseStateMock.mockReset();
    ensureProjectBoardMock.mockReset();
    ensureProjectBoardMock.mockResolvedValue({
      owner: 'octocat',
      title: 'TamTam',
      projectNumber: '7',
      projectUrl: 'https://github.com/users/octocat/projects/7',
      projectId: 'PVT_x',
      statusFieldId: 'F_x',
      optionIds: { 'Todo': '1', 'In Progress': '2', 'Review': '3', 'Fixing': '4', 'Blocked': '5', 'Done': '6' },
      customFieldIds: { project: 'F_P', agent: 'F_A', kind: 'F_K', branch: 'F_B' },
    });

    // Reset config cache between tests so seeded rows don't leak from prior tests.
    reloadConfig();
  });

  return {
    get sharedHandle() {
      return sharedHandle;
    },
    get GET() {
      return GET;
    },
    get PATCH() {
      return PATCH;
    },
  };
}
