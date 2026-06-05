export function statusPath(line: string): string {
  const raw = line.slice(3).trim();
  const renamed = raw.split(' -> ');
  return renamed[renamed.length - 1] || raw;
}

function cleanStatusPath(path: string): string {
  return path.replace(/^"(.*)"$/, '$1');
}

export function statusPaths(line: string): string[] {
  const raw = line.slice(3).trim();
  const renamed = raw.split(' -> ');
  return (renamed.length > 1 ? renamed.filter(Boolean) : [raw]).map(cleanStatusPath);
}

export function isTamtamPath(path: string): boolean {
  return path === '.tamtam' || path.startsWith('.tamtam/');
}

export function isCommittedTamtamMetadataPath(path: string): boolean {
  return path === '.tamtam/config.yml'
    || path === '.tamtam/.gitignore'
    || path === '.tamtam/agents'
    || path.startsWith('.tamtam/agents/');
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

export function statusHasOnlyCommittedTamtamMetadataPaths(status: string): boolean {
  let sawPath = false;
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    sawPath = true;
    if (!statusPaths(line).every(isCommittedTamtamMetadataPath)) return false;
  }
  return sawPath;
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
