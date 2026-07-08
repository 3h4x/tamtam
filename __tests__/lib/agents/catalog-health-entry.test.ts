import { describe, it, expect } from 'vitest';
import { AGENT_CATALOG, autoSeededCatalogEntries, findCatalogEntry } from '@/lib/agents/catalog';
import { RECOMMENDED_AGENTS } from '@/lib/agents/recommended-agents';
import { HEALTH_SKILL_ID } from '@/lib/agents/skill-ids';

describe('health catalog entry', () => {
  it('is present with the right dispatch/role/boostable/schedule/model', () => {
    const e = findCatalogEntry('health');
    expect(e).not.toBeNull();
    expect(e!.dispatch).toBe('cli');
    expect(e!.autoSeed).toBe(true);
    expect(e!.role).toBe('monitor');
    expect(e!.boostable).toBe(false);
    expect(e!.defaultSchedule).toBe('1h');
    expect(e!.defaultModel).toBe('fast');
    expect(e!.skillIds).toContain(HEALTH_SKILL_ID);
  });

  it('is picked up by the auto-seed set', () => {
    expect(autoSeededCatalogEntries().map((e) => e.name)).toContain('health');
  });

  it('is NOT offered as a user-add template (auto-seeded, not manual)', () => {
    expect(RECOMMENDED_AGENTS.map((t) => t.name)).not.toContain('health');
  });

  it('keeps every catalog entry name unique', () => {
    const names = AGENT_CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
