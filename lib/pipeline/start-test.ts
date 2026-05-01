import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, openSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn, execSync } from 'child_process';
import { getImproveConfig, getProjectTestConfig } from '@/lib/scheduling/scheduling';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { createJob, listJobs, probeJobStatus, updateJob, markDone } from '@/lib/jobs/job-storage';
import { getLock, acquireLock, isLockOwnedByActiveRelease } from './pipeline-lock';
import { runGates } from '@/lib/shared/job-control';

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
  if (existsSync(join(projPath, 'pyproject.toml')) || existsSync(join(projPath, 'requirements.txt'))) {
    const venvPython = join(projPath, '.venv', 'bin', 'python');
    return existsSync(venvPython) ? `${venvPython} -m pytest` : 'python3 -m pytest';
  }
  const pkgJson = join(projPath, 'package.json');
  if (existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8'));
      if (pkg.scripts?.test) {
        return existsSync(join(projPath, 'pnpm-lock.yaml')) ? 'pnpm test' : 'npm test';
      }
    } catch {}
  }
  if (existsSync(join(projPath, 'foundry.toml'))) return 'forge test';
  if (existsSync(join(projPath, 'Package.swift'))) {
    // Guard against triggering macOS Xcode GUI dialogs when running headless.
    // xcode-select -p exits 0 only when developer tools are properly configured.
    try { execSync('xcode-select -p', { stdio: 'ignore', timeout: 3000 }); } catch { return null; }
    return 'swift test';
  }
  if (existsSync(join(projPath, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(join(projPath, 'go.mod'))) return 'go test ./...';
  if (existsSync(join(projPath, 'pom.xml'))) return 'mvn test';
  if (existsSync(join(projPath, 'build.gradle')) || existsSync(join(projPath, 'build.gradle.kts'))) return 'gradle test';
  for (const mk of ['Makefile', 'makefile', 'GNUmakefile']) {
    const p = join(projPath, mk);
    if (existsSync(p)) {
      try {
        if (/^test\s*:/m.test(readFileSync(p, 'utf-8'))) return 'make test';
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
  const paused = runGates('start tests');
  if (paused) return paused;

  // Check for existing pipeline lock — but allow running under a parent
  // release job's lock (this step was kicked off by the release pipeline).
  const underRelease = isLockOwnedByActiveRelease(projectName);
  if (!underRelease) {
    const lock = getLock(projectName);
    if (lock) {
      return { ok: false, status: 409, detail: `Pipeline is running for ${projectName}`, blockingJobId: lock.lockedByJobId };
    }
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

  const testCmd = detectTestCommand(projPath, projectName);
  if (!testCmd) {
    return { ok: false, status: 400, detail: `Could not detect test command for ${projectName}` };
  }

  mkdirSync(logDir, { recursive: true });

  const job = createJob(projectName, 'test', 0, '');
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  const scriptPath = join(logDir, `${job.id}.sh`);
  writeFileSync(scriptPath, [
    '#!/bin/bash',
    `export PATH="${process.env.PATH || ''}"`,
    `export HOME="${homedir()}"`,
    `cd "${projPath}"`,
    `echo "Running: ${testCmd}"`,
    'echo "---"',
    `${testCmd} 2>&1`,
  ].join('\n'));
  chmodSync(scriptPath, 0o755);

  const logFd = openSync(logPath, 'w');
  const proc = spawn('bash', [scriptPath], {
    cwd: projPath,
    stdio: ['ignore', logFd, logFd],
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

  proc.on('exit', (code) => {
    try { closeSync(logFd); } catch {}
    markDone(job, code ?? -1).catch((e) => {
      console.log(`[start-test] markDone failed for ${job.id}:`, e);
    });
  });

  return { ok: true, jobId: job.id, pid: job.pid, logPath, testCmd };
}
