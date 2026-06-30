import { describe, it, expect } from 'vitest';
import { parseIssueStamp } from '@/lib/agents/issue-stamp';

describe('parseIssueStamp', () => {
  it('stamps number, title, and repo from a full pick_top payload', () => {
    const stdout = JSON.stringify({
      chosenIssue: 42,
      issue: {
        number: 42,
        title: 'Fix the thing',
        url: 'https://github.com/acme/widget/issues/42',
      },
    });
    expect(parseIssueStamp(stdout)).toEqual({
      number: 42,
      title: 'Fix the thing',
      repo: 'acme/widget',
    });
  });

  it('stamps the number even when title and url are absent', () => {
    expect(parseIssueStamp(JSON.stringify({ chosenIssue: 7 }))).toEqual({ number: 7 });
  });

  it('omits repo when the url is not a github.com issue url', () => {
    const stdout = JSON.stringify({
      chosenIssue: 9,
      issue: { title: 'Self-hosted', url: 'https://git.example.com/acme/widget/issues/9' },
    });
    expect(parseIssueStamp(stdout)).toEqual({ number: 9, title: 'Self-hosted' });
  });

  it('returns null when chosenIssue is null', () => {
    expect(parseIssueStamp(JSON.stringify({ chosenIssue: null, reason: 'no_eligible_issue' }))).toBeNull();
  });

  it('returns null when chosenIssue is missing', () => {
    expect(parseIssueStamp(JSON.stringify({ issue: { title: 'x' } }))).toBeNull();
  });

  it('returns null for non-numeric chosenIssue', () => {
    expect(parseIssueStamp(JSON.stringify({ chosenIssue: '5' }))).toBeNull();
  });

  it('returns null for malformed / non-JSON output', () => {
    expect(parseIssueStamp('not json at all')).toBeNull();
    expect(parseIssueStamp('')).toBeNull();
    expect(parseIssueStamp(null)).toBeNull();
    expect(parseIssueStamp(undefined)).toBeNull();
  });
});
