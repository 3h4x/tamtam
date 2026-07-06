import { exec } from '@/lib/shared/shell';

/**
 * Resolve a pull request's author GitHub login via `gh`, or null when it can't
 * be determined (lookup failure or no mapped author). Used to trust-gate the
 * merge/approve actions: on a public repo anyone can open a PR, so a merge/
 * approve must verify the author is in the project's safe_users /
 * trusted_github_users before acting. A null return is treated as untrusted
 * (fail closed) by callers.
 */
export async function getPrAuthorLogin(repo: string, prNumber: number): Promise<string | null> {
  const r = await exec(
    'gh',
    ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'author', '--jq', '.author.login'],
    { timeout: 15000 },
  );
  if (r.exitCode !== 0) return null;
  const login = r.stdout.trim();
  return login && login !== 'null' ? login : null;
}
