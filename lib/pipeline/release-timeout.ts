import { loadFileConfig } from '@/lib/skills/tamtam-file-config';
import { getSettings } from '@/lib/shared/config';

export function resolveReleaseTimeoutMinutes(projectPath: string): number {
  const fileConfig = loadFileConfig(projectPath);
  if (fileConfig?.release_timeout_minutes && fileConfig.release_timeout_minutes > 0) {
    return fileConfig.release_timeout_minutes;
  }
  return getSettings().release_wall_clock_timeout_minutes;
}

export function computeReleaseDeadlineAt(projectPath: string, nowMs = Date.now()): number {
  return nowMs + resolveReleaseTimeoutMinutes(projectPath) * 60 * 1000;
}
