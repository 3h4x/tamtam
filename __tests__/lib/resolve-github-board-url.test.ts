import { describe, expect, it } from 'vitest';
import { resolveGithubBoardUrl } from '@/lib/client/resolve-github-board-url';

describe('resolveGithubBoardUrl', () => {
  it('returns an empty string when sync is disabled', () => {
    expect(
      resolveGithubBoardUrl({
        github_board_sync_enabled: false,
        github_board_view_url: 'https://github.com/orgs/acme/projects/1/views/2',
        github_board_project_url: 'https://github.com/orgs/acme/projects/1',
      }),
    ).toBe('');
  });

  it('treats the string "true" as enabled and prefers the trimmed view URL', () => {
    expect(
      resolveGithubBoardUrl({
        github_board_sync_enabled: 'true',
        github_board_view_url: ' https://github.com/orgs/acme/projects/1/views/2 ',
        github_board_project_url: 'https://github.com/orgs/acme/projects/1',
      }),
    ).toBe('https://github.com/orgs/acme/projects/1/views/2');
  });

  it('falls back to the trimmed project URL when the view URL is blank', () => {
    expect(
      resolveGithubBoardUrl({
        github_board_sync_enabled: true,
        github_board_view_url: '   ',
        github_board_project_url: ' https://github.com/orgs/acme/projects/1 ',
      }),
    ).toBe('https://github.com/orgs/acme/projects/1');
  });

  it('returns an empty string for missing settings', () => {
    expect(resolveGithubBoardUrl(undefined)).toBe('');
  });
});
