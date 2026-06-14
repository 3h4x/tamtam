import { vi } from 'vitest';


// --- Hoisted mock state shared across describe blocks. Each test mutates
// these refs to vary behavior without paying for vi.resetModules() +
// re-import on every test. The route module is imported exactly once.
const state = vi.hoisted(() => ({
  projectPath: '' as string | null,
  projectRow: undefined as {
    website?: string | null;
    qaUrl?: string | null;
    devServerStartCommand?: string | null;
    devServerStopCommand?: string | null;
    devServerReadyUrl?: string | null;
  } | undefined,
  testCfg: null as Record<string, unknown> | null,
  pushResult: null as Record<string, unknown> | null,
  pipelinePrompts: {
    reviewPromptAddendum: null as string | null,
    reviewPrerequisiteCommand: null as string | null,
    fixPromptAddendum: null as string | null,
  },
  fileConfig: null as Record<string, unknown> | null,
  branchCtx: { currentBranch: 'main', defaultBranch: 'main', isDefaultBranch: true },
  improveProjects: {} as Record<string, unknown>,
  parseTestScheduleToCronImpl: ((s: string) => {
    if (s === 'bogus') throw new Error(`Invalid schedule: ${s}`);
    return s;
  }) as (s: string) => string,
}));

const mocks = vi.hoisted(() => ({
  resolveProjectPath: vi.fn(),
  clearProjectDataCache: vi.fn(),
  reloadConfig: vi.fn(),
  writeProjectFieldYaml: vi.fn(),
  getProjectTestConfig: vi.fn(),
  getProjectPushResult: vi.fn(),
  getProjectPipelinePrompts: vi.fn(),
  installTestSchedule: vi.fn(),
  uninstallTestSchedule: vi.fn(),
  loadFileConfig: vi.fn(),
  writeFileConfig: vi.fn(),
  getBranchContext: vi.fn(),
}));

vi.mock('@/lib/shared/project-data', () => ({
  resolveProjectPath: mocks.resolveProjectPath,
  clearProjectDataCache: mocks.clearProjectDataCache,
}));

vi.mock('@/lib/db', () => {
  const rows = () => (state.projectRow ? [state.projectRow] : []);
  const whereResult = {
    get: () => state.projectRow,
    limit: () => Promise.resolve(rows()),
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(rows()).then(onFulfilled, onRejected),
  };
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => whereResult,
        }),
      }),
    },
    schema: {
      projects: { name: 'name' },
    },
  };
});

vi.mock('@/lib/shared/config', () => ({ reloadConfig: mocks.reloadConfig }));

vi.mock('@/lib/scheduling/scheduling', () => ({
  getImproveConfig: vi.fn(() => ({ projects: state.improveProjects, claudeBin: 'claude', logDir: '/tmp/logs' })),
  writeProjectFieldYaml: mocks.writeProjectFieldYaml,
  getProjectTestConfig: mocks.getProjectTestConfig,
  getProjectPushResult: mocks.getProjectPushResult,
  getProjectPipelinePrompts: mocks.getProjectPipelinePrompts,
}));

vi.mock('@/lib/scheduling/test-scheduler', () => ({
  installTestSchedule: mocks.installTestSchedule,
  uninstallTestSchedule: mocks.uninstallTestSchedule,
  parseTestScheduleToCron: (s: string) => state.parseTestScheduleToCronImpl(s),
}));

vi.mock('@/lib/skills/tamtam-file-config', () => ({
  loadFileConfig: mocks.loadFileConfig,
  writeFileConfig: mocks.writeFileConfig,
  getBranchContext: mocks.getBranchContext,
}));

const routeModulePromise = import('@/app/api/projects/by-project/[projectName]/config/route');

function resetMocks() {
  mocks.resolveProjectPath.mockReset();
  mocks.clearProjectDataCache.mockReset();
  mocks.reloadConfig.mockReset();
  mocks.writeProjectFieldYaml.mockReset();
  mocks.getProjectTestConfig.mockReset();
  mocks.getProjectPushResult.mockReset();
  mocks.getProjectPipelinePrompts.mockReset();
  mocks.installTestSchedule.mockReset();
  mocks.uninstallTestSchedule.mockReset();
  mocks.loadFileConfig.mockReset();
  mocks.writeFileConfig.mockReset();
  mocks.getBranchContext.mockReset();
  state.projectRow = undefined;
  state.improveProjects = {};
  state.parseTestScheduleToCronImpl = (s: string) => {
    if (s === 'bogus') throw new Error(`Invalid schedule: ${s}`);
    return s;
  };
}

export { mocks, resetMocks, routeModulePromise, state };
