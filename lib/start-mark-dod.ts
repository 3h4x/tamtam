import { appendFileSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveProjectPath } from './project-data';
import { getImproveConfig } from './scheduling';
import { exec } from './shell';
import { getPermissionModeFlag } from './config';
import { createJob, listJobs, markDone } from './job-storage';

export type MarkDodResult =
  | { ok: true; jobId: string; issueNumber: number; verified: number; total: number; changed: boolean }
  | { ok: false; status: number; detail: string };

function findIssueContext(projectName: string): { number: number; repo: string } | null {
  const job = listJobs()
    .filter(j => j.project === projectName && j.kind === 'run' && j.ghIssueNumber != null)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!job || job.ghIssueNumber == null || !job.ghIssueRepo) return null;
  return { number: job.ghIssueNumber, repo: job.ghIssueRepo };
}

// Extract acceptance criteria (unchecked checkbox lines) from issue body.
export function extractCriteria(body: string): Array<{ raw: string; text: string }> {
  const out: Array<{ raw: string; text: string }> = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^(\s*[-*]\s+)\[\s\]\s+(.+)$/);
    if (m) out.push({ raw: line, text: m[2].trim() });
  }
  return out;
}

// Replace the `- [ ]` of matching criterion lines with `- [x]`. Matches by the
// exact criterion text captured by extractCriteria.
export function tickCriteria(body: string, verifiedTexts: Set<string>): { body: string; ticked: number } {
  let ticked = 0;
  const out = body.split('\n').map(line => {
    const m = line.match(/^(\s*[-*]\s+)\[\s\](\s+)(.+)$/);
    if (!m) return line;
    const text = m[3].trim();
    if (verifiedTexts.has(text)) {
      ticked++;
      return `${m[1]}[x]${m[2]}${m[3]}`;
    }
    return line;
  }).join('\n');
  return { body: out, ticked };
}

/**
 * After review passes, verify which acceptance criteria in the linked GitHub
 * issue are *actually implemented* on the current branch — not just claimed —
 * then tick those boxes on the issue. Claude runs with tool access (read / grep
 * / bash) so it can inspect the codebase, run greps, peek at tests, etc. rather
 * than relying on a paper check of the diff.
 *
 * Failures are best-effort and never block the pipeline — returns ok:true with
 * changed:false on any recoverable error.
 */
export async function startMarkDod(projectName: string): Promise<MarkDodResult> {
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return { ok: false, status: 404, detail: 'project not found' };

  const issueCtx = findIssueContext(projectName);
  if (!issueCtx) return { ok: false, status: 400, detail: 'no issue context on latest run' };

  const { logDir, claudeBin } = getImproveConfig();
  mkdirSync(logDir, { recursive: true });

  // pid=0 — inline job with no spawned process; avoids markDone's SIGKILL
  // fallback taking out our own children (Turbopack workers etc).
  const job = createJob(projectName, 'mark-dod', 0, '');
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;
  const log = (s: string) => { try { appendFileSync(logPath, s); } catch {} };

  log(`# mark-dod start — ${new Date().toISOString()}\n# issue: ${issueCtx.repo}#${issueCtx.number}\n`);

  try {
    // 1. Fetch the issue body.
    const viewR = await exec('gh', ['issue', 'view', String(issueCtx.number), '--repo', issueCtx.repo, '--json', 'body,title'], { cwd: projPath, timeout: 15000 });
    if (viewR.exitCode !== 0) {
      log(`# gh issue view failed: ${viewR.stderr}\n`);
      await markDone(job, 1);
      return { ok: true, jobId: job.id, issueNumber: issueCtx.number, verified: 0, total: 0, changed: false };
    }
    let parsed: { body?: string; title?: string } = {};
    try { parsed = JSON.parse(viewR.stdout); } catch {}
    const body = parsed.body ?? '';
    const title = parsed.title ?? '';
    const criteria = extractCriteria(body);
    if (criteria.length === 0) {
      log(`# no unchecked DoD boxes — nothing to verify\n`);
      await markDone(job, 0);
      return { ok: true, jobId: job.id, issueNumber: issueCtx.number, verified: 0, total: 0, changed: false };
    }
    log(`# found ${criteria.length} unchecked criteria to verify\n`);

    // 2. Ask Claude to VERIFY each criterion against the actual codebase. We
    // let Claude use tools (Read/Grep/Glob/Bash) — verification needs the
    // ability to probe the repo, not just stare at a diff summary.
    const criteriaList = criteria.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
    const prompt = `You are verifying whether each acceptance criterion below is ACTUALLY IMPLEMENTED on the current branch of this repository (cwd). Do not take claims at face value — check the code, tests, config, etc. For each criterion either confirm it against concrete evidence (file paths, symbol names, test names) or mark it unverified.

Repository: ${projectName}
Issue #${issueCtx.number}: ${title}

Acceptance criteria:
${criteriaList}

TASK:
- Use your tools (Read / Grep / Glob / Bash) to inspect the repo as needed.
- For each criterion decide: VERIFIED or NOT VERIFIED.
- A criterion is VERIFIED only if you have seen the concrete implementation — not just intent, not just a TODO, not just "probably".
- Output a single JSON object and nothing else. No prose, no markdown fences.

JSON schema:
{
  "results": [
    { "index": 1, "text": "<exact criterion text>", "verified": true|false, "evidence": "<one sentence — file/symbol/test, or why unverified>" }
  ]
}`;

    log(`# asking claude to verify each criterion against the codebase...\n`);
    const claudeR = await exec(
      claudeBin,
      [
        '--print',
        '--system-prompt',
        'You verify whether acceptance criteria are implemented in a codebase. Use tools to inspect real code. Output strict JSON only.',
        ...getPermissionModeFlag().split(' '),
        '--model', 'haiku',
        '-p', prompt,
      ],
      { cwd: projPath, timeout: 180000 },
    );
    log(`# claude exit ${claudeR.exitCode}\n`);
    if (claudeR.exitCode !== 0 || !claudeR.stdout.trim()) {
      log(`# claude verification failed: ${claudeR.stderr || 'empty output'}\n`);
      await markDone(job, 1);
      return { ok: true, jobId: job.id, issueNumber: issueCtx.number, verified: 0, total: criteria.length, changed: false };
    }

    // Pull the first JSON object out of Claude's output (tolerant of stray
    // prose or code fences even though the prompt forbids them).
    const raw = claudeR.stdout;
    let jsonText = raw.trim();
    const fenceMatch = jsonText.match(/```(?:json)?\n([\s\S]*?)\n```/);
    if (fenceMatch) jsonText = fenceMatch[1];
    else {
      const braceStart = jsonText.indexOf('{');
      const braceEnd = jsonText.lastIndexOf('}');
      if (braceStart >= 0 && braceEnd > braceStart) jsonText = jsonText.slice(braceStart, braceEnd + 1);
    }

    let results: Array<{ text: string; verified: boolean; evidence?: string }> = [];
    try {
      const parsedResult = JSON.parse(jsonText);
      if (Array.isArray(parsedResult.results)) results = parsedResult.results;
    } catch (e) {
      log(`# could not parse claude JSON: ${e}\n--- raw output ---\n${raw.slice(0, 2000)}\n`);
      await markDone(job, 1);
      return { ok: true, jobId: job.id, issueNumber: issueCtx.number, verified: 0, total: criteria.length, changed: false };
    }

    const verifiedTexts = new Set(
      results.filter(r => r.verified === true).map(r => (r.text ?? '').trim()),
    );
    // Log the per-criterion verdict for operator review.
    for (const r of results) {
      log(`# [${r.verified ? 'VERIFIED' : 'unverified'}] ${(r.text ?? '').slice(0, 120)}\n#   evidence: ${(r.evidence ?? '').slice(0, 300)}\n`);
    }
    log(`# summary: ${verifiedTexts.size} / ${criteria.length} verified\n`);

    if (verifiedTexts.size === 0) {
      log(`# no criteria verified — leaving issue body unchanged\n`);
      await markDone(job, 0);
      return { ok: true, jobId: job.id, issueNumber: issueCtx.number, verified: 0, total: criteria.length, changed: false };
    }

    // 3. Tick only the verified boxes and push the updated body to GitHub.
    const { body: updated, ticked } = tickCriteria(body, verifiedTexts);
    if (ticked === 0 || updated === body) {
      log(`# claude's verified texts didn't match any checkbox exactly — skipping edit\n`);
      await markDone(job, 0);
      return { ok: true, jobId: job.id, issueNumber: issueCtx.number, verified: verifiedTexts.size, total: criteria.length, changed: false };
    }

    const tmpFile = join(tmpdir(), `tamtam-issue-${issueCtx.number}-${Date.now()}.md`);
    writeFileSync(tmpFile, updated);
    try {
      const editR = await exec('gh', ['issue', 'edit', String(issueCtx.number), '--repo', issueCtx.repo, '--body-file', tmpFile], { cwd: projPath, timeout: 15000 });
      if (editR.stdout) log(editR.stdout);
      if (editR.stderr) log(editR.stderr);
      if (editR.exitCode !== 0) {
        log(`# gh issue edit failed\n`);
        await markDone(job, 1);
        return { ok: true, jobId: job.id, issueNumber: issueCtx.number, verified: verifiedTexts.size, total: criteria.length, changed: false };
      }
      log(`# DoD updated on ${issueCtx.repo}#${issueCtx.number}: ticked ${ticked} of ${criteria.length}\n`);
      await markDone(job, 0);
      return { ok: true, jobId: job.id, issueNumber: issueCtx.number, verified: verifiedTexts.size, total: criteria.length, changed: true };
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  } catch (e) {
    log(`# mark-dod error: ${e instanceof Error ? e.message : String(e)}\n`);
    await markDone(job, 1);
    return { ok: false, status: 500, detail: `mark-dod failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
