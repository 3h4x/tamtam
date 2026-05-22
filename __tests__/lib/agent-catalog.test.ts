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

  it('autoSeed=true implies dispatch=internal (no auto-seed for CLI templates)', () => {
    for (const entry of AGENT_CATALOG) {
      if (entry.autoSeed) {
        expect(entry.dispatch, `'${entry.name}' is autoSeed but dispatch is not internal`).toBe('internal');
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
  it('mirrors every CLI-dispatch catalog entry', () => {
    const cliNames = catalogEntriesByDispatch('cli').map((e) => e.name).sort();
    const recommendedNames = RECOMMENDED_AGENTS.map((a) => a.name).sort();
    expect(recommendedNames).toEqual(cliNames);
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
  });
});

describe('legacy system facade', () => {
  it('SYSTEM_AGENTS contains every auto-seeded internal entry', () => {
    const autoSeeded = autoSeededCatalogEntries().map((e) => e.name).sort();
    const systemKeys = Object.keys(SYSTEM_AGENTS).sort();
    expect(systemKeys).toEqual(autoSeeded);
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
