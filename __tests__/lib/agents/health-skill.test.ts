import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { HEALTH_SKILL_ID } from '@/lib/agents/skill-ids';

describe('health skill', () => {
  it('exposes the agent-health skill id', () => {
    expect(HEALTH_SKILL_ID).toBe('agent-health');
  });

  it('ships a file-based skill matching the id', () => {
    const path = join(process.cwd(), 'skills/docs/skills/tamtam', `${HEALTH_SKILL_ID}.md`);
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, 'utf-8');
    // Front-matter + a machine-parseable verdict contract the finalize hook relies on.
    expect(body).toMatch(/^---/);
    expect(body).toContain('HEALTH_VERDICT:');
    expect(body).toMatch(/docs\/HEALTH\.md/);
  });
});
