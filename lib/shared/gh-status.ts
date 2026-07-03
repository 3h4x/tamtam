import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { exec } from '@/lib/shared/shell';
import { getSettings } from '@/lib/shared/config';
import { homedir } from 'os';

const GH_CACHE_TTL = 3600;
const GH_CACHE_TTL_FAILURE = 300;
const GH_CACHE_TTL_PENDING = 30;

export interface GhStatusEntry {
  release: string | null;
  ci: string | null;
  ciFailedUrl: string | null;
  headSha: string | null;
  localHeadSha: string | null;
  fetchedAt: string;
}

function nowUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function getEntry(project: string): Promise<GhStatusEntry | null> {
  const rows = await db
    .select()
    .from(schema.ghStatus)
    .where(eq(schema.ghStatus.project, project))
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;
  return {
    release: row.releaseTag,
    ci: row.ci,
    ciFailedUrl: row.ciFailedUrl,
    headSha: row.headSha,
    localHeadSha: row.localHeadSha,
    fetchedAt: row.fetchedAt,
  };
}

// Cheap cached read of a single project's gh status row (CI conclusion +
// failed-run URL). No git/gh subprocess — unlike `ghStatusLookup`, which also
// refreshes stale entries. Used by the release-start CI-red gate, which must
// stay fast and side-effect-free.
export async function readCachedGhStatus(project: string): Promise<GhStatusEntry | null> {
  return getEntry(project);
}

function setEntry(project: string, data: GhStatusEntry): void {
  void db.insert(schema.ghStatus)
    .values({
      project,
      releaseTag: data.release,
      ci: data.ci,
      ciFailedUrl: data.ciFailedUrl,
      headSha: data.headSha,
      localHeadSha: data.localHeadSha,
      fetchedAt: data.fetchedAt || nowUtc(),
    })
    .onConflictDoUpdate({
      target: schema.ghStatus.project,
      set: {
        releaseTag: data.release,
        ci: data.ci,
        ciFailedUrl: data.ciFailedUrl,
        headSha: data.headSha,
        localHeadSha: data.localHeadSha,
        fetchedAt: data.fetchedAt || nowUtc(),
      },
    })
    .execute()
    .catch((e) => console.error('[gh-status] setEntry failed:', e));
}

async function getAllEntries(): Promise<Record<string, GhStatusEntry>> {
  const rows = await db.select().from(schema.ghStatus);
  const result: Record<string, GhStatusEntry> = {};
  for (const row of rows) {
    result[row.project] = {
      release: row.releaseTag,
      ci: row.ci,
      ciFailedUrl: row.ciFailedUrl,
      headSha: row.headSha,
      localHeadSha: row.localHeadSha,
      fetchedAt: row.fetchedAt,
    };
  }
  return result;
}

export function invalidateProject(project: string): void {
  void getEntry(project).then((existing) => {
    const entry = existing || {
      release: null,
      ci: null,
      ciFailedUrl: null,
      headSha: null,
      localHeadSha: null,
      fetchedAt: nowUtc(),
    };
    entry.ci = 'in_progress';
    entry.ciFailedUrl = null;
    entry.fetchedAt = '1970-01-01T00:00:00Z';
    setEntry(project, entry);
  }).catch((e) => console.error('[gh-status] invalidateProject failed:', e));
}

export function extractGithubRepoFromUrl(url: string): string | null {
  const match = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)(?:\/|$)/i);
  return match?.[1] ?? null;
}

export async function resolveGithubRepo(
  projName: string,
  cfg: { github?: string | null; path?: string }
): Promise<string> {
  if (cfg.github) return cfg.github;
  if (cfg.path) {
    const expanded = cfg.path.startsWith('~') ? cfg.path.replace('~', homedir()) : cfg.path;
    try {
      const r = await exec('git', ['-C', expanded, 'remote', 'get-url', 'origin'], { timeout: 5000 });
      if (r.exitCode === 0) {
        let url = r.stdout.trim();
        if (url.startsWith('git@github.com:')) {
          url = url.slice('git@github.com:'.length).replace(/\.git$/, '');
          if (url.includes('/')) return url;
        } else if (url.startsWith('https://github.com/')) {
          url = url.slice('https://github.com/'.length).replace(/\.git$/, '');
          if (url.includes('/')) return url;
        }
      }
    } catch {}
  }
  const owner = process.env.GITHUB_OWNER || getSettings().github_owner || projName;
  return `${owner}/${projName}`;
}

function verKey(t: string): [number, number, number] {
  const m = t.match(/v?(\d+)\.(\d+)\.?(\d*)/);
  if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3] || '0')];
  return [-1, -1, -1];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

async function latestTagWithSha(path: string): Promise<[string | null, string | null]> {
  const expanded = path.startsWith('~') ? path.replace('~', homedir()) : path;
  try {
    const result = await exec('git', ['ls-remote', '--tags', 'origin'], {
      cwd: expanded,
      timeout: 10000,
    });
    if (result.exitCode !== 0 || !result.stdout.trim()) return [null, null];

    const tags: Record<string, string> = {};
    const deref: Record<string, string> = {};
    for (const line of result.stdout.split('\n')) {
      const parts = line.split('\t');
      if (parts.length !== 2) continue;
      const sha = parts[0].trim();
      const ref = parts[1].trim();
      if (!ref.startsWith('refs/tags/')) continue;
      const name = ref.slice('refs/tags/'.length);
      if (name.endsWith('^{}')) {
        deref[name.slice(0, -3)] = sha;
      } else {
        tags[name] = sha;
      }
    }

    const semverTags = Object.keys(tags).filter(
      (t) => compareSemver(verKey(t), [-1, -1, -1]) !== 0
    );
    if (semverTags.length === 0) return [null, null];

    const best = semverTags.reduce((a, b) =>
      compareSemver(verKey(a), verKey(b)) >= 0 ? a : b
    );
    const sha = deref[best] || tags[best];
    return [best, sha];
  } catch {
    return [null, null];
  }
}

async function localHead(path: string): Promise<string | null> {
  const expanded = path.startsWith('~') ? path.replace('~', homedir()) : path;
  try {
    const result = await exec('git', ['rev-parse', 'HEAD'], { cwd: expanded, timeout: 5000 });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

// Workflows excluded from CI status evaluation. We deliberately keep release
// workflows IN scope: when a release fails the user needs to see it as a CI
// failure (otherwise the fix-ci button never surfaces). Only filter routine
// dependency-bot and labeler workflows here.
const NARROW_FILTER = '^dependency[\\\\w -]*$|^label$';
const EVAL_JQ = [
  '| sort_by(.createdAt) | reverse',
  '| unique_by(.workflowName) as $runs',
  '| {',
  '  ci: (if ($runs | any(.conclusion == "failure" or .conclusion == "timed_out")) then "failure"',
  '       elif ($runs | any(.status == "in_progress" or .status == "queued")) then "in_progress"',
  '       elif (($runs | length) > 0) and ($runs | all(.conclusion == "success" or .conclusion == "skipped" or .conclusion == "neutral")) then "success"',
  '       else "" end),',
  '  failed_url: ($runs | map(select(.conclusion == "failure" or .conclusion == "timed_out")) | first | .url // null)',
  '}',
].join('');

async function ciForSha(
  repo: string,
  sha: string,
  nameFilter: string | null = NARROW_FILTER
): Promise<[string | null, string | null]> {
  const filterExpr = nameFilter
    ? `select(.workflowName | ascii_downcase | test("${nameFilter}") | not)`
    : '.';
  try {
    const result = await exec(
      'gh',
      [
        'run',
        'list',
        '--repo',
        repo,
        '--commit',
        sha,
        '--json',
        'conclusion,status,url,workflowName,createdAt',
        '-q',
        `[.[] | ${filterExpr}]${EVAL_JQ}`,
      ],
      { timeout: 10000 }
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      const data = JSON.parse(result.stdout.trim());
      return [data.ci || null, data.failed_url || null];
    }
  } catch {}
  return [null, null];
}

async function fetchOneGhStatus(
  repo: string,
  path?: string
): Promise<GhStatusEntry> {
  const result: GhStatusEntry = {
    release: null,
    ci: null,
    ciFailedUrl: null,
    headSha: null,
    localHeadSha: null,
    fetchedAt: nowUtc(),
  };

  let tagCommitSha: string | null = null;
  if (path) {
    const [tag, sha] = await latestTagWithSha(path);
    result.release = tag;
    tagCommitSha = sha;
  }

  try {
    // Prefer the SHA of the project's *current local branch*, not the
    // default branch on origin. When the user is on a feature branch with
    // a failing PR, the failing CI run is associated with that branch's
    // HEAD commit — not with master's HEAD. Looking up the default branch
    // would surface a stale or absent CI status. Falls back to remote
    // default HEAD when path is unavailable.
    let headSha: string | null = null;
    if (path) {
      headSha = await localHead(path);
    }
    if (!headSha) {
      const shaResult = await exec(
        'gh',
        ['api', `repos/${repo}/commits/HEAD`, '--jq', '.sha'],
        { timeout: 10000 }
      );
      headSha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : null;
    }

    if (headSha) {
      let [ci, failedUrl] = await ciForSha(repo, headSha);
      if (ci === null) {
        [ci, failedUrl] = await ciForSha(repo, headSha, null);
      }
      if (ci === null && tagCommitSha && tagCommitSha !== headSha) {
        [ci, failedUrl] = await ciForSha(repo, tagCommitSha);
        if (ci === null) {
          [ci, failedUrl] = await ciForSha(repo, tagCommitSha, null);
        }
      }
      if (ci) result.ci = ci;
      if (failedUrl) result.ciFailedUrl = failedUrl;
      result.headSha = headSha;
    }
  } catch {}

  return result;
}

export async function ghStatusLookup(
  projects: Record<string, { project: string; github?: string | null; path?: string }>
): Promise<Record<string, GhStatusEntry>> {
  const now = Date.now();
  const cache: Record<string, GhStatusEntry> = {};

  for (const [proj, entry] of Object.entries(await getAllEntries())) {
    cache[proj] = entry;
  }

  // Deduplicate: one entry per project name. The repo lookup may shell out
  // to `git remote get-url`; do them in parallel so this scales with project
  // count instead of summing the git latencies.
  const projectCfgs = Object.values(projects);
  const seen = new Set<string>();
  const dedupCfgs: { project: string; github?: string | null; path?: string }[] = [];
  for (const cfg of projectCfgs) {
    if (!seen.has(cfg.project)) {
      seen.add(cfg.project);
      dedupCfgs.push(cfg);
    }
  }
  const repos = await Promise.all(
    dedupCfgs.map((cfg) => resolveGithubRepo(cfg.project, cfg)),
  );
  const unique: Record<string, { repo: string; path: string }> = {};
  for (let i = 0; i < dedupCfgs.length; i++) {
    unique[dedupCfgs[i].project] = { repo: repos[i], path: dedupCfgs[i].path ?? '' };
  }

  // Probe every project's local HEAD in parallel before the staleness loop so
  // subprocess latency scales with the slowest project instead of the sum of
  // every project's git rev-parse.
  const uniqueEntries = Object.entries(unique);
  const localShaList = await Promise.all(
    uniqueEntries.map(async ([, { path }]) => (path ? await localHead(path) : null)),
  );
  const localShas = new Map<string, string | null>();
  for (let i = 0; i < uniqueEntries.length; i++) {
    localShas.set(uniqueEntries[i][0], localShaList[i]);
  }

  const stale: [string, string][] = [];
  for (const [projName, { repo }] of uniqueEntries) {
    const entry = cache[projName];
    if (!entry) {
      stale.push([projName, repo]);
      continue;
    }

    const lastLocalSha = entry.localHeadSha;
    const localSha = localShas.get(projName) ?? null;

    if (lastLocalSha && localSha && !localSha.startsWith(lastLocalSha.slice(0, 12))) {
      cache[projName] = {
        ...entry,
        ci: 'in_progress',
        ciFailedUrl: null,
        fetchedAt: '1970-01-01T00:00:00Z',
        localHeadSha: localSha,
      };
      setEntry(projName, cache[projName]);
      stale.push([projName, repo]);
      continue;
    }

    if (!lastLocalSha && localSha) {
      stale.push([projName, repo]);
      continue;
    }

    const fetchedAt = new Date(entry.fetchedAt.replace('Z', '+00:00')).getTime();
    if (!Number.isFinite(fetchedAt)) {
      stale.push([projName, repo]);
    } else {
      const ttl =
      entry.ci === 'in_progress' ? GH_CACHE_TTL_PENDING :
      entry.ci === 'failure' ? GH_CACHE_TTL_FAILURE :
      GH_CACHE_TTL;
      if ((now - fetchedAt) / 1000 > ttl) {
        stale.push([projName, repo]);
      }
    }
  }

  if (stale.length > 0) {
    const results = await Promise.all(
      stale.map(async ([projName, repo]) => {
        const { path } = unique[projName];
        try {
          const data = await fetchOneGhStatus(repo, path || undefined);
          data.localHeadSha = await localHead(path);
          return [projName, data] as const;
        } catch {
          return null;
        }
      })
    );

    for (const result of results) {
      if (result) {
        const [projName, data] = result;
        cache[projName] = data;
        setEntry(projName, data);
      }
    }
  }

  return cache;
}
