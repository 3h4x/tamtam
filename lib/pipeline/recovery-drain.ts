// Recovery helpers for deferred release / agent work.
//
// Invariant: if a project has both a pending release and DB-queued agent runs,
// the release must get first chance to reacquire the pipeline lock before any
// queued agent is replayed. Otherwise an older queued release can be overtaken
// by newer agent work and ship a different tree than intended.

declare global {
  var __tamtamProjectRecoveryDrains: Map<string, Promise<void>> | undefined;
}

const activeProjectRecoveryDrains =
  globalThis.__tamtamProjectRecoveryDrains ?? new Map<string, Promise<void>>();

globalThis.__tamtamProjectRecoveryDrains = activeProjectRecoveryDrains;

function uniqueProjects(projects: string[]): string[] {
  return [...new Set(projects.filter((project) => typeof project === 'string' && project.length > 0))];
}

export async function drainQueuedAgentsForProjectIfClear(
  project: string,
  logPrefix = '[recovery]',
): Promise<void> {
  const { getPendingRelease } = await import('./pending-release');
  if (await getPendingRelease(project)) {
    console.log(`${logPrefix} keeping queued agents behind pending release for ${project}`);
    return;
  }

  const { getLock } = await import('./pipeline-lock');
  if (await getLock(project)) return;

  const { drainQueuedAgentRunsForProject } = await import('@/lib/agents/queued-agent-runs');
  await drainQueuedAgentRunsForProject(project);
}

async function runProjectRecoveryWork(
  project: string,
  logPrefix = '[recovery]',
): Promise<void> {
  const { drainPendingRelease, getPendingRelease } = await import('./pending-release');
  await drainPendingRelease(project);
  if (await getPendingRelease(project)) {
    console.log(`${logPrefix} release still pending for ${project}; leaving queued agents deferred`);
    return;
  }
  // Queued terminal runs (user input) replay before agents. Self-guards: it
  // no-ops if a blocking job (e.g. a release that just reacquired its lock) is
  // running, and re-fires from the finish-seam once that clears.
  try {
    const { drainNextTerminalRun } = await import('@/lib/terminal/pending-terminal-run');
    await drainNextTerminalRun(project);
  } catch (err) {
    console.error(`${logPrefix} terminal-run drain failed for ${project}:`, err);
  }
  await drainQueuedAgentsForProjectIfClear(project, logPrefix);
}

export async function drainProjectRecoveryWork(
  project: string,
  logPrefix = '[recovery]',
): Promise<void> {
  const active = activeProjectRecoveryDrains.get(project);
  if (active) {
    await active;
    return;
  }

  const drain = runProjectRecoveryWork(project, logPrefix);
  activeProjectRecoveryDrains.set(project, drain);
  try {
    await drain;
  } finally {
    if (activeProjectRecoveryDrains.get(project) === drain) {
      activeProjectRecoveryDrains.delete(project);
    }
  }
}

export async function drainAllRecoveryWork(logPrefix = '[recovery]'): Promise<void> {
  const { listPendingReleaseProjects } = await import('./pending-release');
  const { listQueuedAgentRunProjects } = await import('@/lib/agents/queued-agent-runs');
  const { listQueuedTerminalRunProjects } = await import('@/lib/terminal/pending-terminal-run');
  // Independent DB list queries — read them in parallel.
  const [pending, queued, queuedTerminal] = await Promise.all([
    listPendingReleaseProjects(),
    listQueuedAgentRunProjects(),
    listQueuedTerminalRunProjects(),
  ]);
  const projects = uniqueProjects([...pending, ...queued, ...queuedTerminal]);
  // Tests assert strict per-project call ordering on the mocked drain
  // helpers, so iterate sequentially. Resume-edge latency is small enough
  // (N projects × short awaits) that parallelism isn't a worthwhile change
  // here. Per-project drain ordering matches the legacy completion-hook
  // chain, which preserves expectations elsewhere too.
  for (const project of projects) {
    try {
      await drainProjectRecoveryWork(project, logPrefix);
    } catch (err) {
      console.error(`${logPrefix} drain failed for ${project}:`, err);
    }
  }
}

export async function drainUnlockedQueuedAgentRuns(
  logPrefix = '[queued-agent-runs]',
): Promise<void> {
  const { listQueuedAgentRunProjects } = await import('@/lib/agents/queued-agent-runs');
  for (const project of uniqueProjects(await listQueuedAgentRunProjects())) {
    try {
      await drainQueuedAgentsForProjectIfClear(project, logPrefix);
    } catch (err) {
      console.error(`${logPrefix} drain failed for ${project}:`, err);
    }
  }
}
