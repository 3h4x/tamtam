import { exec } from '@/lib/shared/shell';

/**
 * Cumulative uncommitted line delta (added + removed) across the entire
 * working tree, measured by `git diff --numstat HEAD`. Untracked files are
 * included via a temporary `--intent-to-add` so newly created files count.
 * Binary rows (numstat `-`) contribute 0. Returns 0 on a clean tree or when
 * git fails — a conservative "below threshold" signal that never blocks a
 * release on its own (the caller only consults this when a threshold is set).
 */
export async function worktreeLineDelta(projPath: string): Promise<number> {
  // Stage intent-to-add for untracked files so they appear in `diff HEAD`,
  // then undo it so we don't leave the index mutated. `add -N` is reversible
  // with `reset` and does not stage content.
  await exec('git', ['-C', projPath, 'add', '-N', '.'], { timeout: 10000 });
  try {
    const r = await exec('git', ['-C', projPath, 'diff', '--numstat', 'HEAD'], { timeout: 10000 });
    if (r.exitCode !== 0) return 0;
    let total = 0;
    for (const line of r.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [added, removed] = trimmed.split('\t');
      if (added === '-' || removed === '-') continue; // binary
      const a = Number.parseInt(added, 10);
      const d = Number.parseInt(removed, 10);
      if (Number.isFinite(a)) total += a;
      if (Number.isFinite(d)) total += d;
    }
    return total;
  } finally {
    // Undo the intent-to-add markers so the index is left as we found it.
    await exec('git', ['-C', projPath, 'reset', '-q'], { timeout: 10000 });
  }
}
