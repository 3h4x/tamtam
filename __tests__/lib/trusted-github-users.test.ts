import { describe, expect, it } from 'vitest';
import {
  canonicalizeTrustedGithubUsers,
  parseTrustedGithubUsers,
  serializeTrustedGithubUsers,
  validateTrustedGithubUsersEntries,
  validateTrustedGithubUsersInput,
} from '@/lib/shared/trusted-github-users';

describe('trusted-github-users', () => {
  it('parses comma and newline separated input, trimming and deduping case-insensitively', () => {
    expect(parseTrustedGithubUsers('octocat, hubot\nOctoCat\n  bot  ')).toEqual([
      'octocat',
      'hubot',
      'bot',
    ]);
  });

  it('canonicalizes array input by keeping only string entries and first-seen casing', () => {
    expect(canonicalizeTrustedGithubUsers([' OctoCat ', 42, 'hubot', 'octocat', '', null])).toEqual([
      'OctoCat',
      'hubot',
    ]);
  });

  it('serializes users as a trimmed comma-separated list', () => {
    expect(serializeTrustedGithubUsers([' octocat ', '', 'hubot  '])).toBe('octocat, hubot');
  });

  it('validates duplicate and empty entries', () => {
    expect(validateTrustedGithubUsersEntries(['octocat', 'OctoCat'])).toBe('Duplicate GitHub login: OctoCat');
    expect(validateTrustedGithubUsersEntries(['octocat', '   '])).toBe('Trusted GitHub users cannot be empty.');
    expect(validateTrustedGithubUsersEntries(['octocat', 'hubot'])).toBeNull();
  });

  it('treats all-empty input as unset but rejects meaningful invalid rows', () => {
    expect(validateTrustedGithubUsersInput(' , \n ')).toBeNull();
    expect(validateTrustedGithubUsersInput('octocat,\n,hubot')).toBe('Trusted GitHub users cannot be empty.');
    expect(validateTrustedGithubUsersInput(['octocat', 'OctoCat'])).toBe('Duplicate GitHub login: OctoCat');
  });
});
