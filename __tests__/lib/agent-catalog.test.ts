import { describe, it, expect } from 'vitest';
import {
  AGENT_CATALOG,
  autoSeededCatalogEntries,
  catalogEntriesByDispatch,
  catalogNameKey,
  catalogNameKeys,
  findCatalogEntry,
  isInCatalog,
} from '@/lib/agents/catalog';
import {
  RECOMMENDED_AGENTS,
  isBuiltInRecommendedAgent,
} from '@/lib/agents/recommended-agents';
import {
  SYSTEM_AGENTS,
  getSystemAgentHandler,
  listSystemAgentSeedConfigs,
} from '@/lib/agents/system/index';

describe('agent catalog', () => {
  it('has at least one entry per dispatch and no duplicates', () => {
    expect(AGENT_CATALOG.length).toBeGreaterThan(0);
    const cliEntries = catalogEntriesByDispatch('cli');
    const internalEntries = catalogEntriesByDispatch('internal');
    expect(cliEntries.length).toBeGreaterThan(0);
    expect(internalEntries.length).toBeGreaterThan(0);

    const allKeys = AGENT_CATALOG.flatMap(catalogNameKeys);
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });

  it('every internal entry has a server handler key; every cli entry does not', () => {
    for (const entry of AGENT_CATALOG) {
      if (entry.dispatch === 'internal') {
        expect(entry.handlerKey, `internal entry '${entry.name}' missing handlerKey`).toBeTypeOf('string');
      } else {
        expect(entry.handlerKey, `cli entry '${entry.name}' must not set handlerKey`).toBeUndefined();
      }
    }
  });

  it('auto-seeded internal entries have a handler key; auto-seeded CLI entries do not', () => {
    // Auto-seed is no longer internal-only: a `dispatch:'cli'` + `autoSeed:true`
    // entry (e.g. `health`) seeds a normal kind:'user' agent that runs the intake
    // workflow. The remaining invariant is the handler split.
    for (const entry of autoSeededCatalogEntries()) {
      if (entry.dispatch === 'internal') {
        expect(entry.handlerKey, `internal auto-seed '${entry.name}' needs a handlerKey`).toBeTypeOf('string');
      } else {
        expect(entry.dispatch, `auto-seed '${entry.name}' must be cli or internal`).toBe('cli');
        expect(entry.handlerKey, `cli auto-seed '${entry.name}' must not set handlerKey`).toBeUndefined();
      }
    }
  });

  it('findCatalogEntry resolves by name and by alias case-insensitively', () => {
    const improve = findCatalogEntry('improve');
    expect(improve?.name).toBe('improve');
    expect(findCatalogEntry('IMPROVE')?.name).toBe('improve');

    const aliasEntry = AGENT_CATALOG.find((e) => (e.aliases?.length ?? 0) > 0);
    expect(aliasEntry, 'fixture: catalog should have at least one entry with aliases').toBeDefined();
    if (aliasEntry) {
      for (const alias of aliasEntry.aliases ?? []) {
        expect(findCatalogEntry(alias)?.name).toBe(aliasEntry.name);
      }
    }
  });

  it('isInCatalog matches name + aliases', () => {
    expect(isInCatalog('improve')).toBe(true);
    expect(isInCatalog('does-not-exist')).toBe(false);
  });

  it('catalogNameKey normalizes whitespace and case', () => {
    expect(catalogNameKey('  Improve  ')).toBe('improve');
    expect(catalogNameKey('IMPROVE')).toBe('improve');
  });
});

describe('legacy recommended-agents facade', () => {
  it('mirrors every non-auto-seeded CLI-dispatch catalog entry', () => {
    // Auto-seeded CLI entries (e.g. `health`) are materialized per project by the
    // seeder, so they are excluded from the manual "Add agent" template list.
    const cliTemplateNames = catalogEntriesByDispatch('cli')
      .filter((e) => !e.autoSeed)
      .map((e) => e.name)
      .sort();
    const recommendedNames = RECOMMENDED_AGENTS.map((a) => a.name).sort();
    expect(recommendedNames).toEqual(cliTemplateNames);
  });

  it('isBuiltInRecommendedAgent returns true only for CLI entries (not internal)', () => {
    const cli = catalogEntriesByDispatch('cli')[0];
    const internal = catalogEntriesByDispatch('internal')[0];
    expect(isBuiltInRecommendedAgent(cli.name)).toBe(true);
    expect(isBuiltInRecommendedAgent(internal.name)).toBe(false);
    expect(isBuiltInRecommendedAgent('unknown-name')).toBe(false);
  });

  it('preserves tier flags on the legacy shape', () => {
    const docsClaude = RECOMMENDED_AGENTS.find((a) => a.name === 'docs-claude');
    expect(docsClaude?.essential).toBe(true);
    const qa = RECOMMENDED_AGENTS.find((a) => a.name === 'qa');
    expect(qa?.featured).toBe(true);
    const improve = RECOMMENDED_AGENTS.find((a) => a.name === 'improve');
    expect(improve?.featured).toBe(true);
    const refactorSplit = RECOMMENDED_AGENTS.find((a) => a.name === 'refactor-split');
    expect(refactorSplit?.featured).toBe(true);
    expect(refactorSplit).toMatchObject({
      model: 'smart',
      schedule: '48h',
      skillIds: ['agent-refactor-split'],
      fallbackEnabled: true,
    });
  });
});

describe('legacy system facade', () => {
  it('SYSTEM_AGENTS contains every auto-seeded internal entry (CLI auto-seed has no handler)', () => {
    // SYSTEM_AGENTS only maps internal-dispatch auto-seed entries to in-process
    // handlers; auto-seeded CLI entries (e.g. `health`) run via the intake
    // workflow and intentionally have no handler here.
    const autoSeededInternal = autoSeededCatalogEntries()
      .filter((e) => e.dispatch === 'internal')
      .map((e) => e.name)
      .sort();
    const systemKeys = Object.keys(SYSTEM_AGENTS).sort();
    expect(systemKeys).toEqual(autoSeededInternal);
  });

  it('getSystemAgentHandler returns null for non-internal or non-auto-seeded names', () => {
    const cliName = catalogEntriesByDispatch('cli')[0].name;
    expect(getSystemAgentHandler(cliName)).toBeNull();
    expect(getSystemAgentHandler('does-not-exist')).toBeNull();
  });

  it('listSystemAgentSeedConfigs preserves prompt + schedule + model', () => {
    const configs = listSystemAgentSeedConfigs();
    expect(configs.length).toBeGreaterThan(0);
    for (const cfg of configs) {
      expect(cfg.name).toBeTruthy();
      expect(cfg.defaultSchedule).toBeTruthy();
      expect(cfg.model).toBeTruthy();
    }
  });
});
