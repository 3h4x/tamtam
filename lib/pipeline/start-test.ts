import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { spawn, execSync } from 'child_process';
import { getImproveConfig, getProjectTestConfig } from '@/lib/scheduling/scheduling';
import { currentParent } from '@/lib/jobs/parent-context';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { shellQuote } from '@/lib/shared/shell';
import { createJob, listJobs, probeJobStatus, updateJob, markDone } from '@/lib/jobs/job-storage';
import { getLock, acquireLock, isLockOwnedByActiveRelease } from './pipeline-lock';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';

export function detectTestCommand(projPath: string, projectName?: string): string | null {
  // Explicit off-switch — overrides user/auto-detected command. Wrapped in
  // try/catch so callers that mock only `getImproveConfig` don't crash on the
  // DB-backed `getProjectTestConfig` lookup.
  if (projectName) {
    try {
      if (getProjectTestConfig(projectName)?.testsDisabled) return null;
    } catch { /* ignore — test env without DB */ }
  }
  if (projectName) {
    const { projects } = getImproveConfig();
    for (const cfg of Object.values(projects)) {
      if (cfg.project === projectName && cfg.test_command) return cfg.test_command;
    }
  }
  if (existsSync(join(/*turbopackIgnore: true*/ projPath, 'pyproject.toml')) || existsSync(join(/*turbopackIgnore: true*/ projPath, 'requirements.txt'))) {
    const venvPython = join(/*turbopackIgnore: true*/ projPath, '.venv', 'bin', 'python');
    return existsSync(venvPython) ? `${venvPython} -m pytest` : 'python3 -m pytest';
  }
  const pkgJson = join(/*turbopackIgnore: true*/ projPath, 'package.json');
  if (existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8'));
      if (pkg.scripts?.test) {
        return existsSync(join(/*turbopackIgnore: true*/ projPath, 'pnpm-lock.yaml')) ? 'pnpm test' : 'npm test';
      }
    } catch {}
  }
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
    if (existsSync(/*turbopackIgnore: true*/ p)) {
      try {
        if (/^test\s*:/m.test(readFileSync(/*turbopackIgnore: true*/ p, 'utf-8'))) return 'make test';
      } catch {}
    }
  }
  return null;
}

export type StartTestResult =
  | { ok: true; jobId: string; pid: number; logPath: string; testCmd: string }
  | { ok: false; status: number; detail: string; blockingJobId?: string };

export async function startProjectTest(projectName: string): Promise<StartTestResult> {
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return { ok: false, status: 404, detail: 'project not found' };
  const gate = await checkCliStartGate('start tests', { parentJobId: currentParent() });
  if (!gate.ok) return gate;

  // Check for existing pipeline lock — but allow running under a parent
  // release job's lock (this step was kicked off by the release pipeline).
  const underRelease = isLockOwnedByActiveRelease(projectName);
  if (!underRelease) {
    const lock = getLock(projectName);
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

  const testCmd = detectTestCommand(projPath, projectName);
  if (!testCmd) {
    return { ok: false, status: 400, detail: `Could not detect test command for ${projectName}` };
  }

  mkdirSync(logDir, { recursive: true });

  const job = createJob(projectName, 'test', 0, '');
  job.provider = gate.provider;
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  const bashCommand = [
    'set -o pipefail',
    `export PATH=${shellQuote(process.env.PATH || '')}`,
    `export HOME=${shellQuote(homedir())}`,
    `cd ${shellQuote(projPath)}`,
    '{',
    `  printf '%s\\n' ${shellQuote(`Running: ${testCmd}`)}`,
    `  printf '%s\\n' ${shellQuote('---')}`,
    `  ${testCmd}`,
    `} 2>&1 | node ${shellQuote(redactScriptPath)} ${shellQuote(logPath)}`,
    'exit ${PIPESTATUS[0]}',
  ].join('\n');

  writeFileSync(logPath, '');
  const proc = spawn('bash', ['-lc', bashCommand], {
    cwd: projPath,
    stdio: 'ignore',
    detached: true,
  });

  job.pid = proc.pid ?? 0;
  proc.unref();
  updateJob(job);

  // Acquire pipeline lock — skip if we're running under a parent release lock
  // (the release meta-job owns the lock for the full pipeline duration).
  if (!underRelease) {
    try {
      await acquireLock(projectName, job.id);
    } catch (e) {
      console.log(`[start-test] failed to acquire pipeline lock for ${projectName}:`, e);
    }
  }

  proc.on('close', (code) => {
    markDone(job, code ?? -1).catch((e) => {
      console.log(`[start-test] markDone failed for ${job.id}:`, e);
    });
  });

  return { ok: true, jobId: job.id, pid: job.pid, logPath, testCmd };
}
