import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAllAgentLastAttempts,
  getAllAgentLastDispatches,
  recordAgentAttempt,
} from '@/lib/scheduling/agent-cron-state';

describe('agent cron state', () => {
  beforeEach(() => {
    delete globalThis.__tamtamAgentLastSkip;
    delete globalThis.__tamtamAgentLastDispatch;
  });

  it('does not treat queued attempts as real dispatches', () => {
    recordAgentAttempt('agent-1', 'dispatched', 'started');
    const before = getAllAgentLastDispatches();

    recordAgentAttempt('agent-1', 'queued', 'queued at /run (project_busy)');

    expect(getAllAgentLastAttempts().get('agent-1')).toMatchObject({
      status: 'queued',
      reason: 'queued at /run (project_busy)',
    });
    expect(getAllAgentLastDispatches()).toEqual(before);
  });
});
