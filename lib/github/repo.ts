import { resolveGithubRepo } from '@/lib/shared/gh-status';
import { getImproveConfig } from '@/lib/scheduling/scheduling';

/**
 * Resolve the `owner/repo` slug using the same project config, git remote,
 * and settings fallback as the existing GitHub issue routes.
 */
export async function resolveGhRepo(projectName: string, projPath: string): Promise<string | null> {
  const { projects } = getImproveConfig();
  const projectCfg = Object.values(projects).find((cfg) => cfg.project === projectName);
  return resolveGithubRepo(projectName, {
    github: projectCfg?.github ?? null,
    path: projPath,
  });
}
