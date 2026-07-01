import { describe, expect, it } from 'vitest';
import { getJobKind, isAgentJobKind, isClaudeBackedJobKind } from '@/lib/jobs/kinds';

describe('job kinds', () => {
  it('normalizes unknown values to an empty string', () => {
    expect(getJobKind(undefined)).toBe('');
    expect(getJobKind(123)).toBe('');
    expect(getJobKind({ kind: 'run' })).toBe('');
  });

  it('detects agent job kinds by prefix', () => {
    expect(isAgentJobKind('agent:cto')).toBe(true);
    expect(isAgentJobKind('run')).toBe(false);
    expect(isAgentJobKind(null)).toBe(false);
  });

  it('marks run, review, fix variants, and agent jobs as Claude-backed', () => {
    expect(isClaudeBackedJobKind('run')).toBe(true);
    expect(isClaudeBackedJobKind('review')).toBe(true);
    expect(isClaudeBackedJobKind('fix')).toBe(true);
    expect(isClaudeBackedJobKind('fix-ci')).toBe(true);
    expect(isClaudeBackedJobKind('mark-dod-verify')).toBe(true);
    expect(isClaudeBackedJobKind('pr-comment-fix')).toBe(true);
    expect(isClaudeBackedJobKind('agent:security-review')).toBe(true);
    expect(isClaudeBackedJobKind('release')).toBe(false);
    expect(isClaudeBackedJobKind(undefined)).toBe(false);
  });
});
