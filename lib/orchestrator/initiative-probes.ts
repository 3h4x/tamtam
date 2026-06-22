import { exec } from '@/lib/shared/shell';
import type { ProbeResults, ProbeFinding } from '@/lib/orchestrator/initiative-miner';

// exec(cmd, args, options) returns Promise<{ stdout, stderr, exitCode }>
// — it never throws on non-zero exit; the try/catch guards only unexpected errors.

const TODO_FILE_CAP = 20;

// First-party source roots — the only places we mine. Repo-relative paths from
// `git grep` look like `lib/foo.ts`, `app/api/x/route.ts`, `components/Bar.tsx`.
// `src/` is included for the Vite / src-dir-Next convention (`src/lib`,
// `src/components`, `src/app`, `src/hooks`, …) so non-app-router repos are not
// invisible to the miner; build output under it is still cut by EXCLUDED_PATH_RE.
const FIRST_PARTY_ROOT_RE = /^(lib|components|app|src)\//;

// Vendored / generated / dependency paths that may be *committed* into a repo.
// (git grep already skips submodules and gitignored/untracked paths; this is the
// second belt for committed vendored or build output.)
const EXCLUDED_PATH_RE =
  /(^|\/)(node_modules|vendor|third[_-]?party|dist|build|out|\.next|generated|__generated__|coverage)(\/|$)/i;

// The engine's own source contains the literal marker pattern and prose about
// TODO/FIXME — never let the miner flag its own machinery (self-match).
const SELF_PATH_RE = /(^|\/)lib\/orchestrator\/initiative-/;

// Actionable TODO/FIXME marker (ERE for `git grep -E`): the word TODO/FIXME
// immediately followed by `:` or `(` — the universal convention for an
// actionable marker (`TODO:`, `FIXME:`, `TODO(owner)`). High precision: it
// catches real markers even mid-comment (`// foo — TODO: bar`) while skipping
// prose ("not just a TODO") and string/regex mentions ("[NETRUNS TODO]",
// "TODO|FIXME") that lack the colon/paren.
const TODO_MARKER_ERE = '(TODO|FIXME)[:(]';

// pnpm/toolchain preflight failures that exit non-zero *before* eslint runs.
// Filing "fix lint" for these is a false positive — the real fix is deps/setup.
const LINT_PREFLIGHT_RE =
  /(ERR_PNPM|is not up to date|runDepsStatusCheck|Cannot find module|Missing script|command "?lint"? not found|No such file)/i;

// Positive evidence that eslint actually ran and reported problems.
const LINT_EVIDENCE_RE = /(\d+\s+problems?\b|\d+\s+errors?\b|\d+\s+warnings?\b|✖|\berror\b|\bwarning\b)/i;

/** Pure: is this repo-relative path a first-party source file worth mining? */
export function isMineableSourceFile(file: string): boolean {
  if (!file) return false;
  if (!/\.(ts|tsx)$/.test(file)) return false;
  if (!FIRST_PARTY_ROOT_RE.test(file)) return false;
  if (EXCLUDED_PATH_RE.test(file)) return false;
  if (SELF_PATH_RE.test(file)) return false;
  return true;
}

/** Pure: map a list of candidate file paths to `todo` findings (filtered + capped). */
export function todoFindings(files: string[]): ProbeFinding[] {
  const mineable: string[] = [];
  for (const raw of files) {
    const file = raw.trim();
    if (isMineableSourceFile(file)) mineable.push(file);
    if (mineable.length >= TODO_FILE_CAP) break;
  }
  return mineable.map((file): ProbeFinding => ({
    kind: 'todo',
    title: `Resolve TODO/FIXME markers in ${file}`,
    rationale: `${file} contains TODO/FIXME comment markers`,
    prompt: `Review the TODO and FIXME comments in ${file}. Resolve each one by implementing it or, if obsolete, removing it. Do not leave the markers in place.`,
    dedupKey: `todo:${file}`,
  }));
}

/** Pure: decide whether a lint run is real debt vs a toolchain/preflight failure. */
export function lintFindings(exitCode: number, output: string): ProbeFinding[] {
  if (exitCode === 0) return [];
  if (LINT_PREFLIGHT_RE.test(output)) return [];
  if (!LINT_EVIDENCE_RE.test(output)) return [];
  return [{
    kind: 'lint',
    title: 'Fix lint errors',
    rationale: 'pnpm lint reported problems',
    prompt: 'Run `pnpm lint` and fix every reported error and warning. Do not disable rules to silence them.',
    dedupKey: 'lint:global',
  }];
}

// ── type-error probe ───────────────────────────────────────────────────────
// `pnpm type-check` (tsc --noEmit) for any TS project. Same preflight discipline
// as lint: a missing script / missing deps is a setup problem, not type debt.
const TYPE_PREFLIGHT_RE =
  /(ERR_PNPM|is not up to date|runDepsStatusCheck|Cannot find module|Missing script|command "?type-check"? not found|No such file|No projects matched)/i;

// Positive evidence tsc actually ran and found type errors.
const TYPE_EVIDENCE_RE = /(error TS\d+|Found \d+ error)/i;

/** Pure: decide whether a type-check run is real type debt vs a toolchain failure. */
export function typeErrorFindings(exitCode: number, output: string): ProbeFinding[] {
  if (exitCode === 0) return [];
  if (TYPE_PREFLIGHT_RE.test(output)) return [];
  if (!TYPE_EVIDENCE_RE.test(output)) return [];
  return [{
    kind: 'type-error',
    title: 'Fix TypeScript type errors',
    rationale: 'pnpm type-check reported type errors',
    prompt: 'Run `pnpm type-check` and fix every reported type error. Do not use `any` or `@ts-ignore` to silence them — fix the underlying type.',
    dedupKey: 'type-error:global',
  }];
}

// ── dep-bump probe ─────────────────────────────────────────────────────────
// `pnpm outdated --format json` → one aggregate finding (never one-per-package,
// to avoid flooding). pnpm exits non-zero when anything is outdated but still
// prints the JSON map on stdout, so we parse stdout regardless of exit code.
/** Pure: map `pnpm outdated --format json` output to a single dep-bump finding. */
export function depBumpFindings(jsonStdout: string): ProbeFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const count = Object.keys(parsed as Record<string, unknown>).length;
  if (count === 0) return [];
  return [{
    kind: 'dep-bump',
    title: `Update ${count} outdated ${count === 1 ? 'dependency' : 'dependencies'}`,
    rationale: `pnpm outdated reports ${count} package(s) behind latest`,
    prompt: 'Run `pnpm outdated` and update the outdated dependencies — patch/minor freely, majors with care (check changelogs for breaking changes). After updating, verify the build and tests still pass. Do not bump a major that breaks the build.',
    dedupKey: 'dep-bump:global',
  }];
}

// ── gh-issue probe (TRUSTED gate only) ─────────────────────────────────────
// Open GitHub issues are language-agnostic "what's to be done", but raw issue
// text is untrusted input. This probe NEVER calls `gh issue list` directly — it
// sources issues through the server-side trusted gate
// (`GET /api/projects/by-project/[project]/issues?trusted_only=1`, which applies
// `filterTrustedIssues → isUserTrusted`). Only **trusted-author** issue numbers
// and titles become initiatives; bodies/comments never enter the prompt
// ("drop > wrap"). The agent reads full context via TamTam's safe issue flow.
// See docs/SECURITY.md (trusted issue-ingestion). Safe-by-default: with no
// `trusted_github_users` / `safe_users` configured, the gate returns nothing.
const GH_ISSUE_CAP = 15;
const GH_ISSUE_FETCH_TIMEOUT_MS = 30_000;
const GH_BLOCKER_LABELS = new Set([
  'blocked', 'needs-info', 'needs-design', 'needs-refinement',
  'discussion', 'question', 'wontfix', 'duplicate', 'human-needed',
]);

/** Pure: shape already-trust-filtered slim issues into gh-issue findings (title only, blocker-labeled dropped, capped). */
export function trustedIssueFindings(trustedIssues: unknown): ProbeFinding[] {
  if (!Array.isArray(trustedIssues)) return [];
  const out: ProbeFinding[] = [];
  for (const raw of trustedIssues) {
    if (!raw || typeof raw !== 'object') continue;
    const it = raw as { number?: unknown; title?: unknown; labels?: unknown };
    if (typeof it.number !== 'number') continue;
    const labels = Array.isArray(it.labels) ? it.labels.map((l) => String(l).toLowerCase()) : [];
    if (labels.some((l) => GH_BLOCKER_LABELS.has(l))) continue;
    const title = typeof it.title === 'string' ? it.title : '';
    out.push({
      kind: 'gh-issue',
      title: `Resolve issue #${it.number}: ${title}`,
      rationale: `Open GitHub issue #${it.number} from a trusted author`,
      prompt: `Resolve trusted GitHub issue #${it.number} ("${title}") in this repo. Read the full issue context through TamTam's safe issue flow (do not run \`gh issue view/list\` directly). Implement what it asks; if it is already done or not actionable, close it with a short comment explaining why.`,
      dedupKey: `gh-issue:${it.number}`,
    });
    if (out.length >= GH_ISSUE_CAP) break;
  }
  return out;
}

async function probeGhIssues(project: string): Promise<ProbeFinding[]> {
  try {
    const base = process.env.TAMTAM_BASE_URL ?? 'http://localhost:1337';
    const res = await fetch(
      `${base}/api/projects/by-project/${encodeURIComponent(project)}/issues?trusted_only=1`,
      { signal: AbortSignal.timeout(GH_ISSUE_FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { issues?: unknown; error?: unknown };
    if (data.error) return [];
    return trustedIssueFindings(data.issues);
  } catch {
    return [];
  }
}

// ── ui-coverage probe ──────────────────────────────────────────────────────
// Detects *recently-added* backend API routes shipped with no UI/client surface
// — the exact "feature added without UI" gap, turned into something the Miner
// catches itself instead of relying on the operator to remember.
//
// Recency-scoped on purpose: auditing every historical route floods API-heavy
// backends with intentionally-internal endpoints (one real repo had 174). The
// signal we actually want is "you just shipped this and forgot the UI", so we
// only consider routes added within the recency window.
const UI_COVERAGE_RECENT_DAYS = 14;

// Internal route kinds that legitimately have no UI (cron/webhook/etc).
const INTERNAL_API_RE =
  /(^|\/)(\.well-known|cron|webhook|streaming|sweep|health|notifications|board-sync|seen|replay-actions)(\/|$)/;

/** Pure: `app/api/foo/[bar]/route.ts` -> `/api/foo/[bar]`; non-route/non-api -> null. */
export function apiRoutePathFromFile(file: string): string | null {
  const m = /^app(\/api\/.*)\/route\.tsx?$/.exec(file.trim());
  return m ? m[1] : null;
}

/** Pure: is this an intentionally-internal route (no UI expected)? */
export function isInternalApiPath(path: string): boolean {
  return INTERNAL_API_RE.test(path);
}

/** Pure: extract unique `/api/...` path literals referenced in client source. */
export function extractApiRefs(text: string): string[] {
  const set = new Set<string>();
  const re = /\/api\/[A-Za-z0-9_/-]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) set.add(m[0].replace(/\/+$/, ''));
  return [...set];
}

/** Pure: is the route path covered by a referenced literal? Prefix-aware so a
 *  base-constant call (`${JOBS_BASE}/notifications`, where `/api/jobs` is the
 *  referenced literal) counts as coverage and is not a false positive. */
export function isPathCovered(path: string, refs: string[]): boolean {
  for (const r of refs) {
    if (r === path) return true;
    if (path.startsWith(`${r}/`)) return true; // ref is an ancestor base of the route
    if (r.startsWith(`${path}/`)) return true; // route is an ancestor of a referenced deeper path
  }
  return false;
}

// ui-coverage is advisory and low-priority — keep it a gentle drip rather than
// flooding the backlog on an API-heavy repo (e.g. one with many admin routes).
const UI_COVERAGE_CAP = 5;

// Pure: parse `git log --name-only --pretty=format:` output to the set of
// added app/api route.ts / route.tsx files (deduped).
export function parseAddedRouteFiles(gitLogStdout: string): string[] {
  const set = new Set<string>();
  for (const raw of gitLogStdout.split('\n')) {
    const line = raw.trim();
    if (/^app\/api\/.*\/route\.tsx?$/.test(line)) set.add(line);
  }
  return [...set];
}

/** Pure: map uncovered, non-internal route files to `ui-coverage` findings. */
export function orphanApiFindings(routeFiles: string[], refs: string[]): ProbeFinding[] {
  const out: ProbeFinding[] = [];
  for (const file of routeFiles) {
    const path = apiRoutePathFromFile(file);
    if (!path || isInternalApiPath(path) || isPathCovered(path, refs)) continue;
    out.push({
      kind: 'ui-coverage',
      title: `API route ${path} has no UI surface`,
      rationale: `No client/page code references ${path} — it may be a feature shipped without a UI.`,
      prompt: `The API route ${path} is not referenced by any UI/client code. Either add a UI surface (page, panel, or action) that uses it, or — if it is intentionally internal (cron/webhook/internal job) — leave it and note why. Do not invent UI for a genuinely internal endpoint.`,
      dedupKey: `ui-coverage:${path}`,
    });
    if (out.length >= UI_COVERAGE_CAP) break;
  }
  return out;
}

async function probeUiCoverage(projectPath: string): Promise<ProbeFinding[]> {
  try {
    // Only routes added within the recency window — see the note above.
    const logRes = await exec(
      'git',
      ['log', `--since=${UI_COVERAGE_RECENT_DAYS} days ago`, '--diff-filter=A',
        '--name-only', '--pretty=format:', '--', 'app/api'],
      { cwd: projectPath, timeout: 30000 },
    );
    const routeFiles = parseAddedRouteFiles(logRes.stdout);
    if (routeFiles.length === 0) return [];
    // Reference set = client/page code that calls an /api path. Include `app`
    // (Next app-router pages fetch from there) but EXCLUDE `app/api` so a route
    // handler's own server-to-server calls don't count as a UI surface.
    const refsRes = await exec(
      'git',
      ['grep', '-hoIE', '/api/[A-Za-z0-9_/-]+', '--', 'components', 'lib', 'hooks', 'app', ':(exclude)app/api'],
      { cwd: projectPath, timeout: 30000 },
    );
    const refs = extractApiRefs(refsRes.stdout);
    // No client references found at all — can't assess coverage, so stay silent
    // rather than flag every route (avoids false-positive flooding).
    if (refs.length === 0) return [];
    return orphanApiFindings(routeFiles, refs);
  } catch {
    return [];
  }
}

async function probeLint(projectPath: string): Promise<ProbeFinding[]> {
  try {
    const res = await exec('pnpm', ['lint'], { cwd: projectPath, timeout: 60000 });
    return lintFindings(res.exitCode, `${res.stdout}\n${res.stderr}`);
  } catch {
    return [];
  }
}

async function probeTypeError(projectPath: string): Promise<ProbeFinding[]> {
  try {
    const res = await exec('pnpm', ['type-check'], { cwd: projectPath, timeout: 120000 });
    return typeErrorFindings(res.exitCode, `${res.stdout}\n${res.stderr}`);
  } catch {
    return [];
  }
}

async function probeDepBump(projectPath: string): Promise<ProbeFinding[]> {
  try {
    const res = await exec('pnpm', ['outdated', '--format', 'json'], { cwd: projectPath, timeout: 60000 });
    return depBumpFindings(res.stdout);
  } catch {
    return [];
  }
}

async function probeTodos(projectPath: string): Promise<ProbeFinding[]> {
  try {
    // `git grep` only searches tracked files and does NOT descend into
    // submodules — so vendored/foundry libs and node_modules are skipped at the
    // source. Limit to the first-party roots; -I skips binary, -l lists files.
    const res = await exec(
      'git',
      ['grep', '-lI', '-E', TODO_MARKER_ERE, '--', 'lib', 'components', 'app', 'src'],
      { cwd: projectPath, timeout: 30000 },
    );
    // git grep exits 1 when there are no matches — stdout is empty, not an error.
    return todoFindings(res.stdout.split('\n'));
  } catch {
    return [];
  }
}

export async function runProbes(project: string, projectPath: string): Promise<ProbeResults> {
  const [lint, todos, uiCoverage, typeErrors, depBumps, ghIssues] = await Promise.all([
    probeLint(projectPath),
    probeTodos(projectPath),
    probeUiCoverage(projectPath),
    probeTypeError(projectPath),
    probeDepBump(projectPath),
    probeGhIssues(project),
  ]);
  return { project, findings: [...lint, ...todos, ...uiCoverage, ...typeErrors, ...depBumps, ...ghIssues] };
}
