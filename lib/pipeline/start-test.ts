import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { spawn, execSync } from 'child_process';
import { getImproveConfig, getProjectTestConfig } from '@/lib/scheduling/scheduling';
import { currentParent } from '@/lib/jobs/parent-context';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { buildChildEnv } from '@/lib/shared/child-env';
import { exec, shellQuote } from '@/lib/shared/shell';
import { db, schema } from '@/lib/db';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';
import { loadFileConfig } from '@/lib/skills/tamtam-file-config';
import { checkPrBranchExecutionGate } from '@/lib/security/pr-branch-execution';
import { createJob, listJobs, probeJobStatus, updateJob, markDone } from '@/lib/jobs/job-storage';
import { parseFailingTests, retryCommandForFailure, allFailuresQuarantined, type ParsedTestFailure, type TestOutcome } from './flaky-tests';
import { getLock, acquireLock, releaseLock, isLockOwnedByActiveRelease } from './pipeline-lock';
import { tryClaimPipelineStartSlot, setPipelineStartSlotJob, releasePipelineStartSlot } from './pipeline-start-slot';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';
import { markCloseHandlerPending, clearCloseHandlerPending } from '@/lib/jobs/spawned-close-pending';
import { killJobProcessGroup, TEST_JOB_TIMEOUT_MS } from '@/lib/jobs/test-timeout-reaper';
import type { JobData } from '@/lib/jobs/types';

const REVIEW_RETEST_REASON = 'review-retest';

export interface StartTestOptions {
  reviewRetest?: boolean;
  approveUntrustedPrBranch?: boolean;
  // Allow uncommitted working-tree changes through the PR-branch gate because
  // they are TamTam's own in-process agent output. Defaults to reading the
  // active release's persisted flag when omitted.
  allowTrustedLocalChanges?: boolean;
}

export function isReviewRetestJob(job: Pick<JobData, 'kind' | 'contextMeta'>): boolean {
  if (job.kind !== 'test' || !job.contextMeta) return false;
  try {
    const meta = JSON.parse(job.contextMeta) as { pipelineReason?: unknown };
    return meta.pipelineReason === REVIEW_RETEST_REASON;
  } catch {
    return false;
  }
}

async function currentCommitSha(projPath: string): Promise<string | null> {
  try {
    const r = await exec('git', ['-C', projPath, 'rev-parse', 'HEAD'], { timeout: 5000 });
    return r.exitCode === 0 ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

async function recordTestOutcomes(args: {
  projectName: string;
  jobId: string;
  failures: ParsedTestFailure[];
  commitSha: string | null;
  outcome: TestOutcome;
  startedAt: number;
}): Promise<void> {
  if (!args.failures.length) return;
  const finishedAt = Date.now() / 1000;
  // Best-effort: recording flaky/quarantine history must never break the test
  // phase. A transient DB error (e.g. pool-acquire timeout under load) while
  // logging an outcome should not turn a passing/flaky run into a release
  // failure — the gating decision is already made by the caller's return value.
  try {
    await db.insert(schema.testRuns).values(args.failures.map((failure) => ({
      project: args.projectName,
      jobId: args.jobId,
      testId: failure.testId,
      framework: failure.framework,
      commitSha: args.commitSha,
      status: args.outcome,
      firstSeenAt: args.startedAt,
      finishedAt,
    }))).execute();
  } catch (error) {
    console.error('[start-test] failed to record test outcomes:', error);
  }
}

async function notifyFlakyTest(projectName: string, jobId: string, failures: ParsedTestFailure[]): Promise<void> {
  if (!failures.length) return;
  try {
    const { notify } = await import('@/lib/shared/notifications');
    await notify({
      event: 'flaky_test_detected',
      project: projectName,
      job_id: jobId,
      status: 'success',
      message: `Flaky test detected: ${failures.map((failure) => failure.testId).join(', ')}`,
      timestamp: Date.now(),
      throttleKeySuffix: failures.map((failure) => failure.testId).sort().join('|'),
    });
  } catch (error) {
    console.error('[start-test] flaky test notification failed:', error);
  }
}

async function classifyFailedTestRun(args: {
  projectName: string;
  projPath: string;
  testCmd: string;
  logPath: string;
  job: JobData;
  childEnv: NodeJS.ProcessEnv;
}): Promise<number> {
  let output = '';
  try {
    output = readFileSync(/*turbopackIgnore: true*/ args.logPath, 'utf-8');
  } catch {
    return 1;
  }

  const failures = parseFailingTests(output);
  if (!failures.length) return 1;

  let testCfg: Awaited<ReturnType<typeof getProjectTestConfig>> | null = null;
  try {
    testCfg = await getProjectTestConfig(args.projectName);
  } catch {
    testCfg = null;
  }
  const quarantinedTests = testCfg?.quarantinedTests ?? [];
  const commitSha = await currentCommitSha(args.projPath);
  if (allFailuresQuarantined(failures, quarantinedTests)) {
    appendRedactedFileSync(args.logPath, `\n# test outcome: quarantined (${failures.length} known flaky test${failures.length === 1 ? '' : 's'} skipped for release gating)\n`);
    await recordTestOutcomes({
      projectName: args.projectName,
      jobId: args.job.id,
      failures,
      commitSha,
      outcome: 'quarantined',
      startedAt: args.job.startedAt,
    });
    return 0;
  }

  const retryFailures = failures
    .map((failure) => ({ failure, command: retryCommandForFailure(failure, args.testCmd) }))
    .filter((item): item is { failure: ParsedTestFailure; command: string } => !!item.command);
  if (!retryFailures.length) return 1;

  appendRedactedFileSync(args.logPath, `\n# flaky-test retry start — ${new Date().toISOString()}\n`);
  const stillFailing: ParsedTestFailure[] = [];
  for (const item of retryFailures) {
    appendRedactedFileSync(args.logPath, `\n# retrying: ${item.failure.testId}\n$ ${item.command}\n`);
    const retry = await exec('bash', ['-lc', item.command], {
      cwd: args.projPath,
      env: Object.fromEntries(
        Object.entries(args.childEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ),
      timeout: TEST_JOB_TIMEOUT_MS,
      scrubSecrets: true,
      killProcessGroup: true,
    });
    appendRedactedFileSync(args.logPath, retry.stdout);
    appendRedactedFileSync(args.logPath, retry.stderr);
    appendRedactedFileSync(args.logPath, `\n# retry exit ${retry.exitCode}\n`);
    if (retry.exitCode !== 0) stillFailing.push(item.failure);
  }

  const outcome: TestOutcome = stillFailing.length === 0 ? 'flaky' : 'fail';
  await recordTestOutcomes({
    projectName: args.projectName,
    jobId: args.job.id,
    failures,
    commitSha,
    outcome,
    startedAt: args.job.startedAt,
  });
  appendRedactedFileSync(args.logPath, `\n# test outcome: ${outcome}\n`);
  if (outcome === 'flaky') {
    await notifyFlakyTest(args.projectName, args.job.id, failures);
    return 0;
  }
  return 1;
}

export async function detectTestCommand(projPath: string, projectName?: string): Promise<string | null> {
  // Explicit off-switch — overrides user/auto-detected command. Wrapped in
  // try/catch so callers that mock only `getImproveConfig` don't crash on the
  // DB-backed `getProjectTestConfig` lookup.
  if (projectName) {
    try {
      if ((await getProjectTestConfig(projectName))?.testsDisabled) return null;
    } catch { /* ignore — test env without DB */ }
  }
  const fileTestCommand = loadFileConfig(projPath)?.test_command?.trim();
  if (fileTestCommand) return fileTestCommand;
  if (projectName) {
    const { projects } = getImproveConfig();
    for (const cfg of Object.values(projects)) {
      if (cfg.project === projectName && cfg.test_command) return cfg.test_command;
    }
  }
  if (existsSync(join(/*turbopackIgnore: true*/ projPath, 'pyproject.toml')) || existsSync(join(/*turbopackIgnore: true*/ projPath, 'requirements.txt'))) {
    const venvPython = join(/*turbopackIgnore: true*/ projPath, '.venv', 'bin', 'python');
    return existsSync(/*turbopackIgnore: true*/ venvPython) ? `${venvPython} -m pytest` : 'python3 -m pytest';
  }
  const pkgJson = join(/*turbopackIgnore: true*/ projPath, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(/*turbopackIgnore: true*/ pkgJson, 'utf-8'));
    if (pkg.scripts?.test) {
      return existsSync(join(/*turbopackIgnore: true*/ projPath, 'pnpm-lock.yaml')) ? 'pnpm test' : 'npm test';
    }
  } catch {}
  if (existsSync(join(/*turbopackIgnore: true*/ projPath, 'foundry.toml'))) return 'forge test';
  if (existsSync(join(/*turbopackIgnore: true*/ projPath, 'Package.swift'))) {
    // Guard against triggering macOS Xcode GUI dialogs when running headless.
    // xcode-select -p exits 0 only when developer tools are properly configured.
    try { execSync('xcode-select -p', { stdio: 'ignore', timeout: 3000 }); } catch { return null; }
    return 'swift test';
  }
  if (existsSync(join(/*turbopackIgnore: true*/ projPath, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(join(/*turbopackIgnore: true*/ projPath, 'go.mod'))) return 'go test ./...';
  if (existsSync(join(/*turbopackIgnore: true*/ projPath, 'pom.xml'))) return 'mvn test';
  if (existsSync(join(/*turbopackIgnore: true*/ projPath, 'build.gradle')) || existsSync(join(/*turbopackIgnore: true*/ projPath, 'build.gradle.kts'))) return 'gradle test';
  for (const mk of ['Makefile', 'makefile', 'GNUmakefile']) {
    const p = join(/*turbopackIgnore: true*/ projPath, mk);
    try {
      if (/^test\s*:/m.test(readFileSync(/*turbopackIgnore: true*/ p, 'utf-8'))) return 'make test';
    } catch {}
  }
  return null;
}

export async function hasRunnableTestCommand(projectName: string): Promise<boolean> {
  let projPath = resolveProjectPath(projectName);
  if (!projPath) {
    const { refreshProjectsCacheSync } = await import('@/lib/shared/enabled-projects');
    await refreshProjectsCacheSync();
    projPath = resolveProjectPath(projectName);
  }
  if (!projPath) return false;
  return (await detectTestCommand(projPath, projectName)) !== null;
}

export type StartTestResult =
  | { ok: true; jobId: string; pid: number; logPath: string; testCmd: string }
  | { ok: false; status: number; detail: string; blockingJobId?: string };

export async function startProjectTest(
  projectName: string,
  options: StartTestOptions = {},
): Promise<StartTestResult> {
  let projPath = resolveProjectPath(projectName);
  if (!projPath) {
    const { refreshProjectsCacheSync } = await import('@/lib/shared/enabled-projects');
    await refreshProjectsCacheSync();
    projPath = resolveProjectPath(projectName);
  }
  if (!projPath) return { ok: false, status: 404, detail: 'project not found' };
  const [gate, underRelease] = await Promise.all([
    checkCliStartGate('start tests', { parentJobId: currentParent() }),
    isLockOwnedByActiveRelease(projectName),
  ]);
  if (!gate.ok) return gate;

  // Check for existing pipeline lock — but allow running under a parent
  // release job's lock (this step was kicked off by the release pipeline).
  if (!underRelease) {
    const lock = await getLock(projectName);
    if (lock) {
      return { ok: false, status: 409, detail: `Pipeline is running for ${projectName}`, blockingJobId: lock.lockedByJobId };
    }
  }

  const blockingJob = await findBlockingRunningJob(
    projectName,
    (job) => job.kind !== 'test' && !(underRelease && job.kind === 'release'),
  );
  if (blockingJob) {
    return {
      ok: false,
      status: 409,
      detail: `Job '${blockingJob.kind}' is already running for ${projectName} (job ${blockingJob.id})`,
      blockingJobId: blockingJob.id,
    };
  }

  // Atomic per-(release, phase) start claim — closes the check-then-create
  // race so concurrent orchestrator resumes can't launch duplicate test jobs
  // for one release. No-op for standalone (non-release) tests.
  const releaseId = currentParent();
  const startClaim = tryClaimPipelineStartSlot(releaseId, 'test');
  if (!startClaim.ok) {
    return { ok: false, status: 409, detail: `Tests already running for ${projectName}`, blockingJobId: startClaim.jobId ?? undefined };
  }
  try {
  const jobs = listJobs();
  const running = jobs.filter(
    (j) => j.project === projectName && j.kind === 'test' && j.finishedAt === null
  );
  for (const j of running) {
    if ((await probeJobStatus(j)) === 'running') {
      return { ok: false, status: 409, detail: `Tests already running for ${projectName}` };
    }
  }

  const { logDir } = getImproveConfig();
  const redactScriptPath = resolve(process.cwd(), 'scripts', 'redact-log-stream.js');

  const testCmd = await detectTestCommand(projPath, projectName);
  if (!testCmd) {
    return { ok: false, status: 400, detail: `Could not detect test command for ${projectName}` };
  }
  if (!options.approveUntrustedPrBranch) {
    const { activeReleaseAllowsTrustedLocalChanges } = await import('./trusted-local-release');
    const allowTrustedLocalChanges = options.allowTrustedLocalChanges ?? activeReleaseAllowsTrustedLocalChanges();
    const prGate = checkPrBranchExecutionGate(projPath, 'run tests', { allowTrustedLocalChanges });
    if (!prGate.ok) return { ok: false, status: 409, detail: prGate.detail };
  }

  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

  const contextMeta = options.reviewRetest
    ? JSON.stringify({ pipelineReason: REVIEW_RETEST_REASON })
    : undefined;
  const job = createJob(projectName, 'test', 0, '', undefined, contextMeta);
  setPipelineStartSlotJob(releaseId, 'test', job.id);
  job.provider = gate.provider;
  const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
  job.logPath = logPath;
  // Persist logPath up-front so probeJobStatus can find the sentinel file
  // even if a worker / Next.js restart kills us before the final updateJob.
  // Without this, the row stays at logPath=null and probe falls through to
  // markDone(-1) when tests run longer than the spawn grace period.
  updateJob(job);

  // Sentinel-file pattern. The spawned bash writes the test command's exit
  // code to a `.exitcode` companion file BEFORE bash itself exits. probe.ts
  // reads that file when it finds the process dead, so a Next.js restart
  // between the test finishing and the in-process `proc.on('close')` handler
  // firing doesn't lose the real exit code (otherwise the probe's ESRCH path
  // wins and the job gets recorded as exit=-1 despite tests passing).
  const exitCodePath = `${logPath}.exitcode`;
  const childEnv = buildChildEnv(undefined, { scrubSecrets: true });
  const bashCommand = [
    'set -o pipefail',
    `export PATH=${shellQuote(childEnv.PATH || '')}`,
    `export HOME=${shellQuote(childEnv.HOME || '')}`,
    `cd ${shellQuote(projPath)}`,
    '{',
    `  printf '%s\\n' ${shellQuote(`Running: ${testCmd}`)}`,
    `  printf '%s\\n' ${shellQuote('---')}`,
    `  ${testCmd}`,
    `} 2>&1 | node ${shellQuote(redactScriptPath)} ${shellQuote(logPath)}`,
    'rc=${PIPESTATUS[0]}',
    `printf '%d' "$rc" > ${shellQuote(exitCodePath)}`,
    'exit $rc',
  ].join('\n');

  writeFileSync(/*turbopackIgnore: true*/ logPath, '');
  const proc = spawn('bash', ['-lc', bashCommand], {
    cwd: projPath,
    stdio: 'ignore',
    detached: true,
    env: childEnv,
  });
  markCloseHandlerPending(job.id);
  let spawnError: unknown = null;
  let spawnErrorFinalized: Promise<void> | null = null;
  proc.on('error', (e) => {
    spawnError = e;
    clearCloseHandlerPending(job.id);
    spawnErrorFinalized = markDone(job, -1).catch((err) => {
      console.log(`[start-test] markDone failed after spawn error for ${job.id}:`, err);
    });
  });

  job.pid = proc.pid ?? 0;
  proc.unref();
  updateJob(job);

  // Wall-clock guard: if the run hangs (e.g. a forked Vitest worker libuv
  // busy-loops on an unclosed IPC fd), `pnpm test` never exits and the
  // `proc.on('close')` below never fires. Kill the whole process group after
  // the cap. `job.pid` is the detached group leader, so killing `-job.pid`
  // reaps the bash wrapper + node + every Vitest worker. The probe-sweep
  // reaper is the cross-restart backstop; this timer is the prompt path while
  // this server instance is alive.
  const testDeadlineTimer = setTimeout(() => {
    console.log(
      `[start-test] job ${job.id} exceeded ${TEST_JOB_TIMEOUT_MS / 60000}min wall-clock; killing process group pid=${job.pid}`,
    );
    killJobProcessGroup(job.pid);
  }, TEST_JOB_TIMEOUT_MS);
  testDeadlineTimer.unref?.();

  // Acquire pipeline lock — skip if we're running under a parent release lock
  // (the release meta-job owns the lock for the full pipeline duration).
  if (!underRelease) {
    try {
      await acquireLock(projectName, job.id);
      if (spawnError) {
        await spawnErrorFinalized;
        await releaseLock(projectName, job.id);
      }
    } catch (e) {
      console.log(`[start-test] failed to acquire pipeline lock for ${projectName}:`, e);
    }
  }

  proc.on('close', (code) => {
    clearTimeout(testDeadlineTimer);
    if (spawnError) return;
    clearCloseHandlerPending(job.id);
    // Prefer the sentinel file's exit code over the proc 'close' code when the
    // close handler reports signal-kill (code=null). The sentinel is written
    // by the spawned bash itself right before exit, so it represents the
    // pipeline's real status even if the OS reaped the process via signal.
    let finalCode = code ?? -1;
    if (code == null) {
      // No existsSync precheck — readFileSync throws ENOENT and the catch
      // leaves finalCode at -1, matching the original fallback semantics.
      try {
        const raw = readFileSync(/*turbopackIgnore: true*/ exitCodePath, 'utf-8').trim();
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n)) finalCode = n;
      } catch { /* fall back to -1 */ }
    }
    const finalize = async () => {
      if (finalCode !== 0) {
        finalCode = await classifyFailedTestRun({
          projectName,
          projPath,
          testCmd,
          logPath,
          job,
          childEnv,
        }).catch((error) => {
          console.error(`[start-test] flaky classification failed for ${job.id}:`, error);
          return finalCode;
        });
        try { writeFileSync(/*turbopackIgnore: true*/ exitCodePath, String(finalCode)); } catch {}
      }
      await markDone(job, finalCode);
    };
    finalize().catch((e) => {
      console.log(`[start-test] markDone failed for ${job.id}:`, e);
    });
  });

  return { ok: true, jobId: job.id, pid: job.pid, logPath, testCmd };
  } finally {
    releasePipelineStartSlot(releaseId, 'test');
  }
}
