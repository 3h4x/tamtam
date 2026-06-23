export function buildProjectPath(projectName: string, tab?: string): string {
  const basePath = `/project/${encodeURIComponent(projectName)}`
  return tab ? `${basePath}/${tab}` : basePath
}

export function buildProjectTerminalPath(
  projectName: string,
  options: { sessionId?: string; jobId?: string } = {},
): string {
  const terminalPath = buildProjectPath(projectName, 'terminal')

  if (options.sessionId) {
    return `${terminalPath}/${encodeURIComponent(options.sessionId)}`
  }

  if (options.jobId) {
    return `${terminalPath}?job=${encodeURIComponent(options.jobId)}`
  }

  return terminalPath
}

export function buildProjectSetupPath(projectName: string): string {
  return `${buildProjectPath(projectName)}/setup`
}
