import { describe, it, expect } from 'vitest';
import { DEFAULTS } from '@/lib/shared/config';

describe('initiative settings defaults', () => {
  it('engine is off by default; mining on; caps sane', () => {
    expect(DEFAULTS.initiative_engine_enabled).toBe(false);
    expect(DEFAULTS.initiative_mining_enabled).toBe(true);
    expect(DEFAULTS.initiative_max_ships_per_day).toBe(3);
    expect(DEFAULTS.initiative_max_backlog_per_project).toBe(50);
  });

  it('dispatch enabled by default', () => {
    expect(DEFAULTS.initiative_dispatch_enabled).toBe(true);
  });

  it('mining interval defaults to 60 minutes', () => {
    expect(DEFAULTS.initiative_mining_interval_minutes).toBe(60);
  });
});
