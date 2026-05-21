import { exec } from '@/lib/shared/shell';
import { detectMainBranch } from '@/lib/pipeline/start-commit';

export interface PrDecision {
  shouldOpenPr: boolean;
  reason: string;
  currentBranch: string;
  defaultBranch: string;
}

export async function decidePrContext(
  projectPath: string,
  signal?: AbortSignal,
): Promise<PrDecision> {
  // The two probes are independent — fire them in parallel so this call
  // (used on every release start to decide PR vs direct push) costs one git
  // round-trip instead of two.
  const [branchR, defaultBranch] = await Promise.all([
    exec('git', ['-C', projectPath, 'branch', '--show-current'], { timeout: 5000, signal }),
    detectMainBranch(projectPath, signal),
  ]);
  const currentBranch = typeof branchR?.stdout === 'string' ? branchR.stdout.trim() : '';
  const shouldOpenPr = !!currentBranch && currentBranch !== defaultBranch;

  return {
    shouldOpenPr,
    reason: shouldOpenPr
      ? `current branch '${currentBranch}' differs from default '${defaultBranch}'`
      : `current branch '${currentBranch || '(detached)'}' matches default '${defaultBranch}'`,
    currentBranch,
    defaultBranch,
  };
}
