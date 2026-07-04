import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the DB seed (gh_status.ci_failed_url upsert) to a no-op chain.
vi.mock('@/lib/db', () => {
  const chain = {
    values: () => chain,
    onConflictDoUpdate: () => chain,
    execute: async () => undefined,
  };
  return { db: { insert: () => chain }, schema: { ghStatus: { project: 'project' } } };
});

import { dispatchAutoFixCiForRedDefaultBranch } from '@/lib/jobs/dispatch-auto-fix-ci';
import { clearAutoFixCiEntry, getAutoFixCiEntry } from '@/lib/jobs/auto-fix-ci-state';

const PROJECT = 'dispatch-test-proj';

describe('dispatchAutoFixCiForRedDefaultBranch', () => {
  beforeEach(() => {
    clearAutoFixCiEntry(PROJECT);
    vi.restoreAllMocks();
  });
  afterEach(() => {
    clearAutoFixCiEntry(PROJECT);
  });

  it('refuses (no dispatch, no fetch) when there is no failing-run URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await dispatchAutoFixCiForRedDefaultBranch(PROJECT, null);
    expect(r.dispatched).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dispatches a fix-ci and records the attempt on the first failing run', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"status":"started"}', { status: 200 }),
    );
    const r = await dispatchAutoFixCiForRedDefaultBranch(PROJECT, 'https://gh/runs/1');
    expect(r.dispatched).toBe(true);
    // POSTs the fix-ci route for the project.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain(`/api/projects/by-project/${PROJECT}/fix-ci`);
    expect(init).toMatchObject({ method: 'POST' });
    // Records the failing run so it isn't re-dispatched.
    expect(getAutoFixCiEntry(PROJECT)).toMatchObject({ lastFailureKey: 'https://gh/runs/1', attempts: 1 });
  });

  it('does NOT re-dispatch the same failing run', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    await dispatchAutoFixCiForRedDefaultBranch(PROJECT, 'https://gh/runs/1');
    fetchSpy.mockClear();
    const second = await dispatchAutoFixCiForRedDefaultBranch(PROJECT, 'https://gh/runs/1');
    expect(second.dispatched).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not burn the attempt budget when the route rejects (e.g. 409 already running)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('CI fix already in progress', { status: 409 }),
    );
    const r = await dispatchAutoFixCiForRedDefaultBranch(PROJECT, 'https://gh/runs/1');
    expect(r.dispatched).toBe(false);
    // No entry recorded → a later pass can retry the same run.
    expect(getAutoFixCiEntry(PROJECT)).toBeUndefined();
  });
});
