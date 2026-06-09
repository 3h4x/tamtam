import { realpathSync } from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';

export interface ProjectRelativePath {
  absolutePath: string;
  relativePath: string;
}

function escapesRoot(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

export function resolveProjectRelativePath(projectPath: string, requestedPath: string): ProjectRelativePath | null {
  const projectRoot = resolve(projectPath);
  const absolutePath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(projectRoot, requestedPath);
  const relativePath = relative(projectRoot, absolutePath);
  if (!relativePath || escapesRoot(relativePath)) return null;
  return { absolutePath, relativePath };
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(/*turbopackIgnore: true*/ path);
  } catch {
    return null;
  }
}

export function realPathStaysInsideProject(projectPath: string, requestedAbsolutePath: string): boolean {
  const projectRealPath = safeRealpath(projectPath);
  const requestedRealPath = safeRealpath(requestedAbsolutePath);

  // Missing targets cannot disclose outside file contents. Let the caller's
  // normal operation report the missing-file error instead of changing that
  // contract at this helper boundary.
  if (!requestedRealPath) return true;

  const root = projectRealPath ?? resolve(projectPath);
  const realRelativePath = relative(root, requestedRealPath);
  return !escapesRoot(realRelativePath);
}
