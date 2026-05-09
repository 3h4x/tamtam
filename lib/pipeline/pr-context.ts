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
  const branchR = await exec(
    'git',
    ['-C', projectPath, 'branch', '--show-current'],
    { timeout: 5000, signal },
  );
  const currentBranch = typeof branchR?.stdout === 'string' ? branchR.stdout.trim() : '';
  const defaultBranch = await detectMainBranch(projectPath, signal);
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
