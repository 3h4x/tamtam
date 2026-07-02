import { describe, it, expect } from 'vitest';
import type { JobData } from '@/lib/jobs/types';
import {
  parseLinkedIssue,
  computeDodFromBody,
  computePrGates,
  issueHasContext,
} from '@/lib/github/issue-row-enrichment';

function job(overrides: Partial<JobData>): JobData {
  return {
    id: Math.random().toString(36).slice(2),
    project: 'proj',
    kind: 'run',
    startedAt: 1000,
    finishedAt: 2000,
    exitCode: 0,
    ...overrides,
  } as JobData;
}

describe('parseLinkedIssue', () => {
  it('extracts the issue number from close/fix/resolve keywords', () => {
    expect(parseLinkedIssue('Closes #42')).toBe(42);
    expect(parseLinkedIssue('this fixes #7 finally')).toBe(7);
    expect(parseLinkedIssue('Resolved #100')).toBe(100);
  });
  it('returns null when no linkage keyword is present', () => {
    expect(parseLinkedIssue('see #42 for context')).toBeNull();
    expect(parseLinkedIssue('')).toBeNull();
    expect(parseLinkedIssue(null)).toBeNull();
  });
});

describe('computeDodFromBody', () => {
  it('reports none when the body has no acceptance criteria', () => {
    expect(computeDodFromBody('just a description')).toEqual({ state: 'none', summary: 'no DoD' });
    expect(computeDodFromBody(null)).toEqual({ state: 'none', summary: 'no DoD' });
  });
  it('warns while criteria remain unchecked', () => {
    const body = '- [x] done one\n- [ ] not yet\n- [ ] also open';
    expect(computeDodFromBody(body)).toEqual({ state: 'warn', summary: '1/3 DoD' });
  });
  it('passes when every criterion is checked', () => {
    const body = '- [x] a\n- [x] b';
    expect(computeDodFromBody(body)).toEqual({ state: 'pass', summary: '2/2 DoD' });
  });
});

describe('issueHasContext', () => {
  it('is true when a run/fix job for the issue carries a session id', () => {
    const jobs = [job({ kind: 'run', ghIssueNumber: 5, sessionId: 'sess-1' })];
    expect(issueHasContext(jobs, 5)).toBe(true);
  });
  it('is false without a session id or matching issue', () => {
    expect(issueHasContext([job({ kind: 'run', ghIssueNumber: 5, sessionId: null })], 5)).toBe(false);
    expect(issueHasContext([job({ kind: 'run', ghIssueNumber: 9, sessionId: 'x' })], 5)).toBe(false);
    expect(issueHasContext([job({ kind: 'test', ghIssueNumber: 5, sessionId: 'x' })], 5)).toBe(false);
  });
});

describe('computePrGates', () => {
  it('returns all-none when there is no linked issue', () => {
    expect(computePrGates([], null, { state: 'none', summary: null })).toEqual({
      issueNumber: null, tests: 'none', review: 'none', dod: 'none', dodSummary: null,
    });
  });

  it('reads tests from the latest test job exit code', () => {
    const jobs = [
      job({ kind: 'test', ghIssueNumber: 3, finishedAt: 1000, exitCode: 1 }),
      job({ kind: 'test', ghIssueNumber: 3, finishedAt: 2000, exitCode: 0 }),
    ];
    expect(computePrGates(jobs, 3, { state: 'none', summary: null }).tests).toBe('pass');
  });

  it('maps the review verdict to a gate state', () => {
    const jobs = [job({ kind: 'review', ghIssueNumber: 3, finishedAt: 5000, exitCode: 0, verdict: 'LGTM' })];
    expect(computePrGates(jobs, 3, { state: 'none', summary: null }).review).toBe('pass');

    const needs = [job({ kind: 'review', ghIssueNumber: 3, finishedAt: 5000, exitCode: 0, verdict: 'NEEDS ATTENTION' })];
    expect(computePrGates(needs, 3, { state: 'none', summary: null }).review).toBe('warn');
  });

  it('carries the pre-resolved dod state through', () => {
    const gates = computePrGates([], 8, { state: 'warn', summary: '1/2 DoD' });
    expect(gates).toMatchObject({ issueNumber: 8, dod: 'warn', dodSummary: '1/2 DoD' });
  });
});
