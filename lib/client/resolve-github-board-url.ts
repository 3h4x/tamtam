type BoardSettings = {
  github_board_sync_enabled?: boolean | string | null
  github_board_project_url?: string | null
  github_board_view_url?: string | null
}

function normalizeUrl(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function resolveGithubBoardUrl(settings: BoardSettings | null | undefined): string {
  if (!settings) return ''

  const syncEnabled = settings.github_board_sync_enabled === true || settings.github_board_sync_enabled === 'true'
  if (!syncEnabled) return ''

  return normalizeUrl(settings.github_board_view_url) || normalizeUrl(settings.github_board_project_url)
}
