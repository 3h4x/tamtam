// Real-world bindings for the pure `runSweep` in `./project-sweep.ts`.
// Resolves each project's git/gh state and dispatches the chosen action
// through tamtam's normal start helpers (so all the existing locking,
// gating, and queueing rules apply automatically).

import { exec } from '@/lib/shared/shell';
import type { ProjectSweepView, SweepDispatchDeps, SweepReport } from '@/lib/jobs/project-sweep';
import { runSweep } from '@/lib/jobs/project-sweep';

async function gitOk(path: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  try {
    const r = await exec('git', ['-C', path, ...args], { timeout: timeoutMs });
    if (r.exitCode !== 0) return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

async function gatherView(name: string): Promise<ProjectSweepView | null> {
  const { resolveProjectPath } = await import('@/lib/shared/project-data');
  const { getCurrentBranchSync, getDefaultBranchSync } = await import('@/lib/git/git-branch');
  const { listEnabledProjects } = await import('@/lib/shared/enabled-projects');
  const { findBlockingRunningJob } = await import('@/lib/jobs/project-active-job');

  const path = resolveProjectPath(name);
  if (!path) return null;

  const project = listEnabledProjects().find((p) => p.name === name) ?? null;
  const paused = !!project?.paused || !!project?.archived;

  const currentBranch = getCurrentBranchSync(path) || '';
  const defaultBranch = getDefaultBranchSync(path) || 'main';

  // `--ignore-submodules` to match `startProjectReview`'s scope — a modified
  // submodule pointer is not reviewable. Without this flag, the sweep counts
  // submodule changes as work and dispatches a release, but every review
  // preflight reports "No uncommitted changes or unpushed commits to review"
  // and the release orphans. Loop forever.
  const status = await gitOk(path, ['status', '--porcelain', '--ignore-submodules']);
  const uncommittedCount = status ? status.split('\n').filter((l) => l.trim().length > 0).length : 0;

  let hasUnpushedCommits = false;
  // Prefer @{u}..HEAD. When there's no upstream configured (typical for a
  // local issue branch that was created but never `push -u`'d), check the
  // remote-tracking ref `origin/<currentBranch>` instead: if it exists, the
  // local commits are already pushed (just lacking local upstream config)
  // and a sweep release would loop forever pushing the same SHAs. Only when
  // there's no remote-tracking ref at all do we fall back to the default-
  // branch comparison.
  const upstreamAhead = await gitOk(path, ['rev-list', '--count', '@{u}..HEAD']);
  if (upstreamAhead !== null) {
    hasUnpushedCommits = parseInt(upstreamAhead, 10) > 0;
  } else if (defaultBranch && currentBranch && currentBranch !== defaultBranch) {
    const originRef = `refs/remotes/origin/${currentBranch}`;
    const hasRemoteRef = (await gitOk(path, ['rev-parse', '--verify', '--quiet', originRef])) !== null;
    if (hasRemoteRef) {
      const remoteAhead = await gitOk(path, ['rev-list', '--count', `${originRef}..HEAD`]);
      hasUnpushedCommits = remoteAhead !== null && parseInt(remoteAhead, 10) > 0;
    } else {
      const branchAhead = await gitOk(path, ['rev-list', '--count', `${defaultBranch}..HEAD`]);
      hasUnpushedCommits = branchAhead !== null && parseInt(branchAhead, 10) > 0;
    }
  }

  const blocking = await findBlockingRunningJob(name);
  const hasActiveJob = blocking !== null;

  // Two independent gh queries — fire them in parallel since neither
  // depends on the other's result. Per-project sweep latency drops from
  // (ci_query + pr_query) to max(ci_query, pr_query).
  //
  //   defaultBranchCi: latest run on the default branch — treat any failure
  //     as a hard block on default-branch releases (a release on top of
  //     broken `main` would re-test the broken state and burn money).
  //   prOnBranch: open PR whose head ref matches currentBranch.
  const onFeatureBranch = !!(currentBranch && currentBranch !== defaultBranch);
  const [ciResult, prResult] = await Promise.allSettled([
    exec(
      'gh',
      ['run', 'list', '--branch', defaultBranch, '--limit', '1', '--json', 'conclusion', '--jq', '.[0].conclusion'],
      { cwd: path, timeout: 8000 },
    ),
    onFeatureBranch
      ? exec(
          'gh',
          [
            'pr', 'list',
            '--head', currentBranch,
            '--state', 'open',
            '--json', 'number,url,mergeable,statusCheckRollup,headRepositoryOwner,headRepository',
            '--limit', '1',
          ],
          { cwd: path, timeout: 8000 },
        )
      : Promise.resolve(null),
  ]);

  let defaultBranchCi: ProjectSweepView['defaultBranchCi'] = null;
  if (ciResult.status === 'fulfilled' && ciResult.value.exitCode === 0) {
    const s = ciResult.value.stdout.trim().toLowerCase();
    if (s === 'success') defaultBranchCi = 'success';
    else if (s === 'failure' || s === 'cancelled' || s === 'timed_out') defaultBranchCi = 'failure';
    else if (s) defaultBranchCi = 'pending';
  }

  let prOnBranch: ProjectSweepView['prOnBranch'] = null;
  if (prResult.status === 'fulfilled' && prResult.value && prResult.value.exitCode === 0) {
    try {
      const arr = JSON.parse(prResult.value.stdout || '[]') as Array<{
        number: number;
        url: string;
        mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
        statusCheckRollup?: Array<{ conclusion?: string }>;
        headRepositoryOwner?: { login?: string };
        headRepository?: { name?: string };
      }>;
      if (arr.length > 0) {
        const pr = arr[0];
        const conclusions = (pr.statusCheckRollup ?? []).map((c) => (c.conclusion ?? '').toUpperCase());
        let ciConclusion: 'success' | 'failure' | 'pending' | null = null;
        if (conclusions.length === 0) ciConclusion = null;
        else if (conclusions.some((c) => c === 'FAILURE' || c === 'CANCELLED' || c === 'TIMED_OUT')) ciConclusion = 'failure';
        else if (conclusions.every((c) => c === 'SUCCESS' || c === 'SKIPPED' || c === 'NEUTRAL')) ciConclusion = 'success';
        else ciConclusion = 'pending';
        const repo = pr.headRepositoryOwner?.login && pr.headRepository?.name
          ? `${pr.headRepositoryOwner.login}/${pr.headRepository.name}`
          : '';
        if (repo) {
          prOnBranch = { number: pr.number, repo, url: pr.url, mergeable: pr.mergeable, ciConclusion };
        }
      }
    } catch {
      // best-effort; leave prOnBranch null on parse failure
    }
  }

  // auto_push_enabled is the operator's explicit authorization for
  // direct-to-default pushes. When true, the sweep treats default-branch
  // pending work as self-healable instead of waiting for an explicit
  // trigger. Read via `getProjectTestConfig` so per-project overrides and
  // file-backed config both flow through. Default false on missing config.
  let autoPushEnabled = false;
  try {
    const { getProjectTestConfig } = await import('@/lib/scheduling/scheduling');
    const cfg = await getProjectTestConfig(name);
    autoPushEnabled = !!cfg?.autoPushEnabled;
  } catch {
    // best-effort — leave autoPushEnabled false
  }

  return {
    name,
    path,
    currentBranch,
    defaultBranch,
    uncommittedCount,
    hasUnpushedCommits,
    hasActiveJob,
    defaultBranchCi,
    prOnBranch,
    paused,
    autoPushEnabled,
  };
}

async function triggerRelease(name: string, reason: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const { dispatchReleaseWorkflow } = await import('@/lib/workflows/dispatch-release');
    const r = await dispatchReleaseWorkflow(name, { queueIfBlocked: false });
    if (r.ok) {
      return { ok: true, detail: 'status' in r && r.status === 'queued' ? 'queued' : `started ${r.jobId ?? ''}` };
    }
    return { ok: false, detail: `${r.detail ?? 'failed'} (sweep reason: ${reason})` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

async function triggerPrWait(
  name: string,
  prNumber: number,
  prRepo: string,
  prUrl: string,
  reason: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const { launchPrWait } = await import('@/lib/pipeline/start-pr-wait');
    const r = launchPrWait(name, prNumber, prRepo, prUrl);
    if ('jobId' in r) return { ok: true, detail: `pr-wait ${r.jobId}` };
    return { ok: false, detail: `${r.error} (sweep reason: ${reason})` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

async function listProjectNames(): Promise<string[]> {
  const { listEnabledProjects } = await import('@/lib/shared/enabled-projects');
  return listEnabledProjects().map((p) => p.name);
}

export async function runProjectSweep(): Promise<SweepReport> {
  const deps: SweepDispatchDeps = {
    listProjects: listProjectNames,
    resolveView: gatherView,
    triggerRelease,
    triggerPrWait,
  };
  const report = await runSweep(deps);
  console.log(
    `[project-sweep] total=${report.total} release=${report.byAction.release} pr-wait=${report.byAction['pr-wait']} skip=${report.byAction.skip} (${report.finishedAt - report.startedAt}ms)`,
  );
  for (const r of report.results) {
    if (r.action !== 'skip') {
      console.log(`[project-sweep] ${r.project}: ${r.action} — ${r.reason}${r.dispatch ? ` → ${r.dispatch.ok ? 'ok' : 'fail'} (${r.dispatch.detail})` : ''}`);
    }
  }
  return report;
}
