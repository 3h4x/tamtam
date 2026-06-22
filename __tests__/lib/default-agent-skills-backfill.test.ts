import { describe, it, expect, beforeEach } from 'vitest';
import { findAgent, resetSeedModuleAndTables, sharedDefaultAgentSkillsHandle, waitForFast, waitForSeedToSettle } from './default-agent-skills-fixtures';
import * as schema from '@/lib/db/schema';

describe('seedDefaultSkills isolated cases', () => {
  let seedFn: typeof import('@/lib/agents/default-agent-skills').seedDefaultSkills;

  beforeEach(async () => {
    seedFn = await resetSeedModuleAndTables();
  });

  it('backfills the trusted-only prerequisite for existing issue-cruncher agents', async () => {
    const now = Date.now() / 1000;
    await sharedDefaultAgentSkillsHandle.db.insert(schema.agents).values({
      id: 'agent-1',
      name: 'issue-cruncher',
      project: 'proj1',
      skillIds: '["agent-issue-cruncher"]',
      docPaths: '[]',
      model: 'normal',
      prompt: '',
      schedule: null,
      enabled: true,
      prerequisiteCommand: null,
      createdAt: now,
      updatedAt: now,
    });

    seedFn();
    await waitForSeedToSettle();

    await waitForFast(async () => {
      const agent = await findAgent('agent-1');
      expect(agent?.prerequisiteCommand).toBe('curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?pick_top=1"');
    });
  });

  it('does not backfill an explicitly cleared issue-cruncher prerequisite', async () => {
    const now = Date.now() / 1000;
    // The subject under test: explicitly-cleared prerequisite should NOT be
    // backfilled. Race-free deterministic signal: insert a sentinel agent
    // alongside whose prerequisite IS null — once backfill updates the
    // sentinel, we know the whole backfill loop has run and any update for
    // agent-2 (the negative case) would have already fired.
    await sharedDefaultAgentSkillsHandle.db.insert(schema.agents).values([
      {
        id: 'agent-2',
        name: 'issue-cruncher',
        project: 'proj1',
        skillIds: '["agent-issue-cruncher"]',
        docPaths: '[]',
        model: 'normal',
        prompt: '',
        schedule: null,
        enabled: true,
        prerequisiteCommand: '',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'agent-2-sentinel',
        name: 'issue-cruncher',
        project: 'proj1',
        skillIds: '["agent-issue-cruncher"]',
        docPaths: '[]',
        model: 'normal',
        prompt: '',
        schedule: null,
        enabled: true,
        prerequisiteCommand: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    seedFn();
    await waitForSeedToSettle();

    // Wait until the backfill has updated the sentinel — by that point any
    // (incorrect) update against agent-2 would also have landed.
    await waitForFast(async () => {
      const sentinel = await findAgent('agent-2-sentinel');
      expect(sentinel?.prerequisiteCommand).toBe('curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?pick_top=1"');
    });

    const agent = await findAgent('agent-2');
    expect(agent?.prerequisiteCommand).toBe('');
  });

});
