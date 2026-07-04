// Mark-dod implementation, split into step-friendly helpers.
//
// The phase workflow in mark-dod-phase.ts calls each helper from its own
// `'use step'` body so the expensive Claude verification gets cached by
// the workflow runtime — a workflow replay (e.g. after a server restart
// between the verify and apply steps) reuses the verification result
// instead of re-burning tokens.
//
// The legacy entry point `startMarkDod` in lib/pipeline/start-mark-dod.ts
// composes these same helpers in sequence, so its observable behavior is
// unchanged.

import { mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { currentParent } from '@/lib/jobs/parent-context';
import { exec as shellExec } from '@/lib/shared/shell';
import { readIssueBody, writeIssueBody } from '@/lib/github/edit-issue-body';
import { getPermissionModeFlag, getPipelineModel, getSettings } from '@/lib/shared/config';
import {
  createJob,
  getJob,
  markDone,
  updateJob,
} from '@/lib/jobs/job-storage';
import { startJobInProcess } from '@/lib/jobs/spawn-claude-detached';
import { waitForJobCompletion } from '@/lib/workflows/wait-for-job';
import type { JobData } from '@/lib/jobs/types';
import { wrapIfUntrusted, withUntrustedPreamble } from '@/lib/shared/untrusted';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';
import { estimatePromptCost, promptEstimateResponseDetail } from '@/lib/jobs/prompt-size';
import { ensureBranchForCtx, type EnsureBranchResult } from '@/lib/pipeline/mark-dod-branch';
import type { CliProvider } from '@/lib/usage/cli-providers';
import {
  findLatestIssueRunContext,
  findLatestPrContext,
  findReleaseScopedIssueContext,
  findReleaseScopedPrContext,
} from '@/lib/pipeline/release-context';
import { listJobs } from '@/lib/jobs/storage';
import { extractCriteria, tickCriteria } from '@/lib/pipeline/mark-dod-criteria';

export type ParsedCriterion = ReturnType<typeof extractCriteria>[number];

export type MarkDodResult =
  | { ok: true; jobId: string; issueNumber: number; verified: number; total: number; changed: boolean }
  | { ok: false; status: number; detail: string };

export interface MarkDodPrepBundle {
  jobId: string;
  projPath: string;
  ctx: { number: number; repo: string; title?: string };
  isPr: boolean;
}

export interface MarkDodFetchBundle {
  body: string;
  title: string;
  authorLogin: string | undefined;
  criteria: ParsedCriterion[];
  /** Optional terminal result (gh view failed, no criteria, …). */
  terminal?: MarkDodResult;
}

export type MarkDodBranchSwitch = EnsureBranchResult;

export interface MarkDodClaudeVerifyResult {
  verifiedTexts: string[];
  rawOutput: string;
  exitCode: number;
  timedOut: boolean;
  /** Set when verification failed irrecoverably (no usable output). */
  terminal?: MarkDodResult;
}

/** Result of dispatching the supervised `mark-dod-verify` job. */
export type MarkDodVerifyDispatch =
  | { verifyJobId: string }
  | { terminal: MarkDodResult };

function buildMarkDodContextMeta(
  ctx: { number: number; repo: string; title?: string },
  isPr: boolean,
  verified: number | null = null,
  total: number | null = null,
): string {
  return JSON.stringify({
    sourceType: isPr ? 'pr' : 'issue',
    sourceNumber: ctx.number,
    sourceRepo: ctx.repo,
    sourceTitle: ctx.title ?? null,
    verified,
    total,
  });
}

function appendLog(job: JobData | null, line: string): void {
  if (!job?.logPath) return;
  try {
    appendRedactedFileSync(job.logPath, line);
  } catch {
    /* log-write failures are non-fatal */
  }
}

interface ContextLookupBundle {
  projectName: string;
  projectJobs: JobData[];
  activeRelease: JobData | null;
}

function findLatestActiveRelease(projectJobs: JobData[]): JobData | null {
  let activeRelease: JobData | null = null;
  for (const job of projectJobs) {
    if (job.kind !== 'release' || job.finishedAt !== null) continue;
    if (!activeRelease || (job.startedAt || 0) > (activeRelease.startedAt || 0)) {
      activeRelease = job;
    }
  }
  return activeRelease;
}

function findIssueContext(bundle: ContextLookupBundle): { number: number; repo: string } | null {
  const { projectName, projectJobs, activeRelease } = bundle;
  const activeReleaseIssue = findReleaseScopedIssueContext(projectName, activeRelease, projectJobs);
  if (activeReleaseIssue) {
    return { number: activeReleaseIssue.number, repo: activeReleaseIssue.repo };
  }
  if (activeRelease) return null;
  const issue = findLatestIssueRunContext(projectName, projectJobs);
  if (!issue) return null;
  return { number: issue.number, repo: issue.repo };
}

function findPrContext(bundle: ContextLookupBundle): { number: number; repo: string } | null {
  const { projectName, projectJobs, activeRelease } = bundle;
  const activeReleasePr = findReleaseScopedPrContext(projectName, activeRelease, projectJobs);
  if (activeReleasePr) return { number: activeReleasePr.number, repo: activeReleasePr.repo };
  if (activeRelease) return null;
  const pr = findLatestPrContext(projectName, projectJobs);
  if (!pr) return null;
  return { number: pr.number, repo: pr.repo };
}

/** Resolve which issue or PR mark-dod should verify against. */
export function resolveMarkDodContext(
  projectName: string,
  override?: { issueNumber?: number; prNumber?: number; repo?: string },
): { ctx: { number: number; repo: string }; isPr: boolean } | null {
  if (override?.repo && (override.issueNumber || override.prNumber)) {
    if (override.issueNumber) {
      return { ctx: { number: override.issueNumber, repo: override.repo }, isPr: false };
    }
    if (override.prNumber) {
      return { ctx: { number: override.prNumber, repo: override.repo }, isPr: true };
    }
  }
  // Cost note: each lookup function (find*IssueContext / find*PrContext)
  // defaults to `listJobs()` and rebuilds its own byId map. Without this
  // hoist, mark-dod paid 4× O(N) scans of the global job cache on every
  // invocation. Fetching once and pre-filtering to per-project rows turns
  // the remaining work O(M) where M is per-project job count (typically
  // 100-1000× smaller than N).
  const allJobs = listJobs();
  const projectJobs = allJobs.filter((j) => j.project === projectName);
  // Mirror `findActiveReleaseJob` semantics: most-recent unfinished release.
  // Multiple shouldn't coexist, but if they do, picking the newest matches
  // every other caller in the codebase.
  const activeRelease = findLatestActiveRelease(projectJobs);
  const bundle: ContextLookupBundle = { projectName, projectJobs, activeRelease };
  const issueCtx = findIssueContext(bundle);
  if (issueCtx) return { ctx: issueCtx, isPr: false };
  const prCtx = findPrContext(bundle);
  if (prCtx) return { ctx: prCtx, isPr: true };
  return null;
}

export interface MarkDodPrepFull {
  bundle: MarkDodPrepBundle;
  job: JobData;
}

/** Resolve project + create the mark-dod job row. Terminal failures returned directly. */
export async function prepareMarkDod(
  projectName: string,
  override?: { issueNumber?: number; prNumber?: number; repo?: string },
): Promise<MarkDodPrepFull | { ok: false; status: number; detail: string }> {
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return { ok: false, status: 404, detail: 'project not found' };

  const resolved = resolveMarkDodContext(projectName, override);
  if (!resolved) return { ok: false, status: 400, detail: 'no issue or PR context on latest run' };
  const { ctx, isPr } = resolved;

  const { logDir } = getImproveConfig();
  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

  const gate = await checkCliStartGate('start DoD verification', { parentJobId: currentParent() });
  if (!gate.ok) return gate;

  const job = createJob(projectName, 'mark-dod', 0, '');
  job.provider = gate.provider;
  job.ghIssueNumber = ctx.number;
  job.ghIssueRepo = ctx.repo;
  job.contextMeta = buildMarkDodContextMeta(ctx, isPr);
  const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
  job.logPath = logPath;
  updateJob(job);

  const ctxLabel = isPr ? 'PR' : 'issue';
  appendLog(job, `# mark-dod start — ${new Date().toISOString()}\n# ${ctxLabel}: ${ctx.repo}#${ctx.number}\n`);

  return { bundle: { jobId: job.id, projPath, ctx, isPr }, job };
}

/** Fetch the gh body + extract unchecked criteria. Returns terminal on failure / no-criteria. */
export async function fetchAndExtractMarkDodCriteria(
  bundle: MarkDodPrepBundle,
  job: JobData | null,
): Promise<MarkDodFetchBundle> {
  const { jobId, projPath, ctx, isPr } = bundle;
  const ctxLabel = isPr ? 'PR' : 'issue';

  const viewR = await readIssueBody({
    projPath,
    repo: ctx.repo,
    number: ctx.number,
    kind: isPr ? 'pr' : 'issue',
  });
  if (!viewR.ok) {
    appendLog(job, `# gh ${ctxLabel} view failed: ${viewR.detail}\n`);
    if (job) await markDone(job, 1);
    return {
      body: '',
      title: '',
      authorLogin: undefined,
      criteria: [],
      terminal: { ok: true, jobId, issueNumber: ctx.number, verified: 0, total: 0, changed: false },
    };
  }

  const body = viewR.body;
  const title = viewR.title;
  if (job) {
    job.ghIssueTitle = title || null;
    job.contextMeta = buildMarkDodContextMeta({ ...ctx, title }, isPr);
    updateJob(job);
  }
  const authorLogin = viewR.authorLogin;
  const criteria = extractCriteria(body);

  if (criteria.length === 0) {
    appendLog(job, `# no unchecked DoD boxes — nothing to verify\n`);
    if (job) await markDone(job, 0);
    return {
      body,
      title,
      authorLogin,
      criteria: [],
      terminal: { ok: true, jobId, issueNumber: ctx.number, verified: 0, total: 0, changed: false },
    };
  }

  appendLog(job, `# found ${criteria.length} unchecked criteria to verify\n`);
  return { body, title, authorLogin, criteria };
}

/** Switch the working tree to the issue/PR feature branch when possible. */
export async function switchBranchForMarkDodVerification(
  bundle: MarkDodPrepBundle,
  job: JobData | null,
): Promise<MarkDodBranchSwitch> {
  const { projPath, ctx, isPr } = bundle;
  const branchSwitch = await ensureBranchForCtx(projPath, ctx, isPr, (s) => appendLog(job, s));
  if (branchSwitch.switched) {
    appendLog(
      job,
      `# checked out ${branchSwitch.targetBranch} (was ${branchSwitch.originalBranch ?? 'detached'}) for verification\n`,
    );
  } else if (branchSwitch.skipped) {
    appendLog(job, `# verification will run on current branch (${branchSwitch.skipped})\n`);
  }
  return branchSwitch;
}

/**
 * Dispatch the supervised `mark-dod-verify` job: build the prompt, apply the
 * prompt-cost gate, create the job row (child of the mark-dod phase job), and
 * spawn Claude via the shared detached-job path (`startJobInProcess`) — the same
 * mechanism test/review use. No inline kill-switch: the shared wall-clock reaper
 * (`mark_dod_verify_timeout_ms`) bounds a hung verify and survives a restart.
 */
export async function startMarkDodVerification(
  bundle: MarkDodPrepBundle,
  job: JobData | null,
  projectName: string,
  fetched: MarkDodFetchBundle,
): Promise<MarkDodVerifyDispatch> {
  const { jobId, projPath, ctx, isPr } = bundle;

  appendLog(job, `# asking claude to verify each criterion against the codebase...\n`);

  const settings = getSettings();
  const provider = (job?.provider ?? 'claude') as CliProvider;
  const claudeBin = resolveCliBin(provider, settings);
  const cliEnv = resolveCliEnv(provider, settings);
  const { logDir } = getImproveConfig();
  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

  const criteriaListRaw = fetched.criteria.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
  const wrappedTitle = wrapIfUntrusted(
    fetched.title,
    isPr ? 'github_pr_title' : 'github_issue_title',
    fetched.authorLogin,
    projPath,
  );
  const wrappedCriteria = wrapIfUntrusted(
    criteriaListRaw,
    isPr ? 'github_pr_body' : 'github_issue_body',
    fetched.authorLogin,
    projPath,
  );
  const prompt = `You are verifying whether each acceptance criterion below is ACTUALLY IMPLEMENTED on the current branch of this repository (cwd). Do not take claims at face value — check the code, tests, config, etc. For each criterion either confirm it against concrete evidence (file paths, symbol names, test names) or mark it unverified.

Repository: ${projectName}
${isPr ? 'PR' : 'Issue'} #${ctx.number}: ${wrappedTitle}

Acceptance criteria:
${wrappedCriteria}

TASK:
- Use your tools (Read / Grep / Glob) to inspect the repo as needed.
- For each criterion decide: VERIFIED or NOT VERIFIED.
- A criterion is VERIFIED only if you have seen the concrete implementation — not just intent, not just a TODO, not just "probably".
- Output a single JSON object and nothing else. No prose, no markdown fences.

JSON schema:
{
  "results": [
    { "index": 1, "text": "<exact criterion text>", "verified": true|false, "evidence": "<one sentence — file/symbol/test, or why unverified>" }
  ]
}`;

  const basePreamble =
    'You verify whether acceptance criteria are implemented in a codebase. Use tools to inspect real code. Output strict JSON only.';
  const fullPrompt = withUntrustedPreamble(`${basePreamble}\n\n---\n\n${prompt}`);
  const dodModel = getPipelineModel('dod');
  const promptEstimate = estimatePromptCost(fullPrompt, { modelTier: dodModel });
  if (promptEstimate.blocked) {
    const detail = promptEstimateResponseDetail(promptEstimate);
    appendLog(job, `# DoD verification blocked: ${detail}\n`);
    if (job) {
      job.promptBytes = promptEstimate.bytes;
      await markDone(job, 1);
    }
    return { terminal: { ok: false, status: 413, detail } };
  }
  const claudeCommand = `${claudeBin} --print ${getPermissionModeFlag()} --model ${dodModel} --allowed-tools Read,Grep,Glob`;

  // Supervised verify job — child of the mark-dod phase job (inherits release
  // scope for trace grouping). Deliberately absent from PIPELINE_STEP_KINDS so
  // it never gates the release; the shared wall-clock reaper bounds its runtime.
  const verify = createJob(
    projectName,
    'mark-dod-verify',
    0,
    '',
    undefined,
    undefined,
    undefined,
    null,
    null,
    null,
    job?.id ?? null,
    provider,
  );
  verify.logPath = join(/*turbopackIgnore: true*/ logDir, `${verify.id}.log`);
  verify.model = dodModel;
  verify.promptBytes = promptEstimate.bytes;
  updateJob(verify);

  try {
    const pid = await startJobInProcess(verify.id, claudeCommand, fullPrompt, projPath, { env: cliEnv });
    verify.pid = pid;
    updateJob(verify);
  } catch (e) {
    appendLog(job, `# failed to start claude verification: ${e instanceof Error ? e.message : String(e)}\n`);
    await markDone(verify, -1);
    if (job) {
      job.contextMeta = buildMarkDodContextMeta({ ...ctx, title: fetched.title }, isPr, 0, fetched.criteria.length);
      updateJob(job);
      await markDone(job, 1);
    }
    return {
      terminal: { ok: true, jobId, issueNumber: ctx.number, verified: 0, total: fetched.criteria.length, changed: false },
    };
  }

  appendLog(job, `# dispatched verify job ${verify.id}\n`);
  return { verifyJobId: verify.id };
}

/**
 * Read a finished `mark-dod-verify` job's log and parse the verification JSON.
 * The exit code + timeout come from the supervised job row (124 = reaped by the
 * shared wall-clock reaper). Failures return a non-gating terminal (0 verified);
 * the unchecked criteria are re-verified on a later run (idempotent resume).
 */
export async function readMarkDodVerificationResult(
  verifyJobId: string,
  bundle: MarkDodPrepBundle,
  job: JobData | null,
  fetched: MarkDodFetchBundle,
): Promise<MarkDodClaudeVerifyResult> {
  const { jobId, ctx, isPr } = bundle;
  const vjob = getJob(verifyJobId);
  const exitCode = vjob?.exitCode ?? 1;
  const timedOut = vjob?.exitCode === 124 || vjob?.finishedAt == null;

  let rawOutput = '';
  if (vjob?.logPath) {
    try {
      rawOutput = readFileSync(/*turbopackIgnore: true*/ vjob.logPath, 'utf-8');
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e;
    }
  }

  const stripped = rawOutput
    .split('\n')
    .map((l) => {
      // Drop pure timestamped tamtam log lines outright.
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}: \[tamtam\]/.test(l)) return '';
      // The `[tamtam] launching: <cmd>` banner is written to the log fd with no
      // trailing newline, and the child CLI's stdout goes to the same fd — so
      // the verification JSON is glued onto the banner line. Dropping the whole
      // line discarded that JSON and made every DoD report 0 verified. Keep
      // everything from the first brace (the glued JSON); drop banner-only lines.
      if (l.startsWith('[tamtam]')) {
        const brace = l.indexOf('{');
        return brace >= 0 ? l.slice(brace) : '';
      }
      return l;
    })
    .join('\n')
    .trim();

  appendLog(job, `# claude exit ${exitCode}${timedOut ? ' (timed out)' : ''}\n`);

  if (exitCode !== 0 || !stripped) {
    if (!stripped) appendLog(job, `# claude output: ${rawOutput.slice(0, 300).trim()}\n`);
    appendLog(job, `# claude verification failed\n`);
    if (job) {
      job.contextMeta = buildMarkDodContextMeta({ ...ctx, title: fetched.title }, isPr, 0, fetched.criteria.length);
      updateJob(job);
      await markDone(job, 1);
    }
    return {
      verifiedTexts: [],
      rawOutput,
      exitCode,
      timedOut,
      terminal: {
        ok: true,
        jobId,
        issueNumber: ctx.number,
        verified: 0,
        total: fetched.criteria.length,
        changed: false,
      },
    };
  }

  let jsonText = stripped;
  const fenceMatch = jsonText.match(/```(?:json)?\n([\s\S]*?)\n```/);
  if (fenceMatch) jsonText = fenceMatch[1];
  else {
    const braceStart = jsonText.indexOf('{');
    const braceEnd = jsonText.lastIndexOf('}');
    if (braceStart >= 0 && braceEnd > braceStart) jsonText = jsonText.slice(braceStart, braceEnd + 1);
  }

  let results: Array<{ text: string; verified: boolean; evidence?: string; index?: number }> = [];
  try {
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed.results)) results = parsed.results;
  } catch (e) {
    appendLog(job, `# could not parse claude JSON: ${e}\n--- raw output ---\n${stripped.slice(0, 2000)}\n`);
    if (job) {
      job.contextMeta = buildMarkDodContextMeta({ ...ctx, title: fetched.title }, isPr, 0, fetched.criteria.length);
      updateJob(job);
      await markDone(job, 1);
    }
    return {
      verifiedTexts: [],
      rawOutput,
      exitCode,
      timedOut,
      terminal: {
        ok: true,
        jobId,
        issueNumber: ctx.number,
        verified: 0,
        total: fetched.criteria.length,
        changed: false,
      },
    };
  }

  const verifiedTexts: string[] = [];
  // Pre-normalize criteria once; fuzzy fallback was re-normalizing every
  // criterion per unmatched result (O(N*M)).
  const norm = (s: string) => s.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  let normalizedCriteria: { orig: string; norm: string }[] | null = null;
  for (const r of results) {
    if (r.verified !== true) continue;
    const idx = typeof r.index === 'number' ? r.index - 1 : -1;
    if (idx >= 0 && idx < fetched.criteria.length) {
      verifiedTexts.push(fetched.criteria[idx].text);
      continue;
    }
    if (!normalizedCriteria) {
      normalizedCriteria = fetched.criteria.map((c) => ({ orig: c.text, norm: norm(c.text) }));
    }
    const want = norm(r.text ?? '');
    const hit = normalizedCriteria.find((c) => c.norm === want);
    if (hit) verifiedTexts.push(hit.orig);
  }
  for (const r of results) {
    appendLog(
      job,
      `# [${r.verified ? 'VERIFIED' : 'unverified'}] ${(r.text ?? '').slice(0, 120)}\n#   evidence: ${(r.evidence ?? '').slice(0, 300)}\n`,
    );
  }
  appendLog(job, `# summary: ${verifiedTexts.length} / ${fetched.criteria.length} verified\n`);

  return { verifiedTexts, rawOutput, exitCode, timedOut };
}

/**
 * Blocking composite: dispatch the supervised verify job, wait for it, read the
 * result. Used by the legacy inline entry point (`startMarkDod`) so pr-wait's
 * post-merge call and the IssuesTab DoD badge keep working without becoming
 * workflow-aware. The phase workflow instead splits these across `'use step'`s
 * so a replay reuses the cached verify job id.
 */
export async function runMarkDodVerificationSupervised(
  bundle: MarkDodPrepBundle,
  job: JobData | null,
  projectName: string,
  fetched: MarkDodFetchBundle,
): Promise<MarkDodClaudeVerifyResult> {
  const dispatch = await startMarkDodVerification(bundle, job, projectName, fetched);
  if ('terminal' in dispatch) {
    return { verifiedTexts: [], rawOutput: '', exitCode: 1, timedOut: false, terminal: dispatch.terminal };
  }
  await waitForJobCompletion(dispatch.verifyJobId);
  return readMarkDodVerificationResult(dispatch.verifyJobId, bundle, job, fetched);
}

/** Apply the verified ticks via gh edit + restore branch + finalize. */
export async function applyAndFinalizeMarkDod(
  bundle: MarkDodPrepBundle,
  job: JobData | null,
  fetched: MarkDodFetchBundle,
  verify: MarkDodClaudeVerifyResult,
  branchSwitch: MarkDodBranchSwitch,
): Promise<MarkDodResult> {
  const { jobId, projPath, ctx, isPr } = bundle;
  const ctxLabel = isPr ? 'PR' : 'issue';

  try {
    if (verify.verifiedTexts.length === 0) {
      appendLog(job, `# no criteria verified — leaving ${ctxLabel} body unchanged\n`);
      if (job) {
        job.contextMeta = buildMarkDodContextMeta({ ...ctx, title: fetched.title }, isPr, 0, fetched.criteria.length);
        updateJob(job);
        await markDone(job, 0);
      }
      return {
        ok: true,
        jobId,
        issueNumber: ctx.number,
        verified: 0,
        total: fetched.criteria.length,
        changed: false,
      };
    }

    const verifiedSet = new Set(verify.verifiedTexts);
    const { body: updated, ticked } = tickCriteria(fetched.body, verifiedSet);

    if (ticked === 0 || updated === fetched.body) {
      appendLog(job, `# claude's verified texts didn't match any checkbox exactly — skipping edit\n`);
      if (job) {
        job.contextMeta = buildMarkDodContextMeta(
          { ...ctx, title: fetched.title },
          isPr,
          verify.verifiedTexts.length,
          fetched.criteria.length,
        );
        updateJob(job);
        await markDone(job, 0);
      }
      return {
        ok: true,
        jobId,
        issueNumber: ctx.number,
        verified: verify.verifiedTexts.length,
        total: fetched.criteria.length,
        changed: false,
      };
    }

    const editR = await writeIssueBody({
      projPath,
      repo: ctx.repo,
      number: ctx.number,
      kind: isPr ? 'pr' : 'issue',
      body: updated,
    });
    if (editR.stdout) appendLog(job, editR.stdout);
    if (editR.stderr) appendLog(job, editR.stderr);
    if (!editR.ok) {
      appendLog(job, `# gh ${ctxLabel} edit failed\n`);
      if (job) {
        job.contextMeta = buildMarkDodContextMeta(
          { ...ctx, title: fetched.title },
          isPr,
          verify.verifiedTexts.length,
          fetched.criteria.length,
        );
        updateJob(job);
        await markDone(job, 1);
      }
      return {
        ok: true,
        jobId,
        issueNumber: ctx.number,
        verified: verify.verifiedTexts.length,
        total: fetched.criteria.length,
        changed: false,
      };
    }
    appendLog(job, `# DoD updated on ${ctx.repo}#${ctx.number}: ticked ${ticked} of ${fetched.criteria.length}\n`);
    if (job) {
      job.contextMeta = buildMarkDodContextMeta(
        { ...ctx, title: fetched.title },
        isPr,
        verify.verifiedTexts.length,
        fetched.criteria.length,
      );
      updateJob(job);
      await markDone(job, 0);
    }
    return {
      ok: true,
      jobId,
      issueNumber: ctx.number,
      verified: verify.verifiedTexts.length,
      total: fetched.criteria.length,
      changed: true,
    };
  } catch (e) {
    appendLog(job, `# mark-dod error: ${e instanceof Error ? e.message : String(e)}\n`);
    if (job) await markDone(job, 1);
    return { ok: false, status: 500, detail: `mark-dod failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    if (branchSwitch.switched && branchSwitch.originalBranch) {
      const originalBranch = branchSwitch.originalBranch;
      try {
        const r = await shellExec('git', ['-C', projPath, 'checkout', originalBranch], { timeout: 10000 });
        appendLog(
          job,
          `# restored branch ${originalBranch}${r.exitCode === 0 ? '' : ` (warning: ${(r.stderr || r.stdout).slice(0, 200)})`}\n`,
        );
      } catch (e) {
        appendLog(
          job,
          `# WARNING: could not restore branch ${originalBranch}: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
  }
}
