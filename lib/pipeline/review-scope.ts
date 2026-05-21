export function statusPath(line: string): string {
  const raw = line.slice(3).trim();
  const renamed = raw.split(' -> ');
  return renamed[renamed.length - 1] || raw;
}

export function isTamtamPath(path: string): boolean {
  return path === '.tamtam' || path.startsWith('.tamtam/');
}

export function statusHasAnyPath(status: string): boolean {
  return status.split('\n').some((line) => Boolean(line.trim()));
}

export function statusHasNonTamtamPath(status: string): boolean {
  return status.split('\n').some((line) => {
    if (!line.trim()) return false;
    return !isTamtamPath(statusPath(line));
  });
}

export function reviewablePathsFromStatus(status: string): string[] {
  const seen = new Set<string>();
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    const path = statusPath(line);
    if (!path || isTamtamPath(path)) continue;
    seen.add(path);
  }
  return [...seen];
}
