import { describe, expect, it } from 'vitest';
import { canExecuteAgentActions } from '@/lib/agents/action-eligibility';

describe('canExecuteAgentActions', () => {
  it('allows issue-cruncher actions on a successful matching issue run', () => {
    expect(canExecuteAgentActions(
      { kind: 'agent:issue-cruncher', exitCode: 0, ghIssueNumber: 42 },
      [{ type: 'issue-comment', number: 42, body: 'Starting work on this now.' }],
    )).toEqual({ ok: true });
  });

  it('allows issue-linked terminal runs with matching action issue numbers', () => {
    expect(canExecuteAgentActions(
      { kind: 'run', exitCode: 0, ghIssueNumber: 7 },
      [{ type: 'issue-close', number: 7, reason: 'completed' }],
    )).toEqual({ ok: true });
  });

  it('rejects non-zero exits even when the action shape is valid', () => {
    expect(canExecuteAgentActions(
      { kind: 'agent:issue-cruncher', exitCode: 1, ghIssueNumber: 42 },
      [{ type: 'issue-close', number: 42, reason: 'not planned' }],
    )).toMatchObject({ ok: false, reason: 'non-zero-exit' });
  });

  it('rejects unrelated agents', () => {
    expect(canExecuteAgentActions(
      { kind: 'agent:qa', exitCode: 0, ghIssueNumber: null },
      [{ type: 'issue-comment', number: 42, body: 'x' }],
    )).toMatchObject({ ok: false, reason: 'unsupported-job-kind' });
  });

  it('rejects plain runs that are not issue-linked', () => {
    expect(canExecuteAgentActions(
      { kind: 'run', exitCode: 0, ghIssueNumber: null },
      [{ type: 'issue-comment', number: 42, body: 'x' }],
    )).toMatchObject({ ok: false, reason: 'unsupported-job-kind' });
  });

  it('rejects numbered actions when the issue-cruncher job was not stamped with an issue', () => {
    expect(canExecuteAgentActions(
      { kind: 'agent:issue-cruncher', exitCode: 0, ghIssueNumber: null },
      [{ type: 'issue-label', number: 42, addLabels: ['needs-info'], removeLabels: [] }],
    )).toMatchObject({ ok: false, reason: 'missing-issue-context' });
  });

  it('rejects actions for a different issue number', () => {
    const result = canExecuteAgentActions(
      { kind: 'agent:issue-cruncher', exitCode: 0, ghIssueNumber: 42 },
      [{ type: 'issue-close', number: 99, reason: 'completed' }],
    );
    expect(result).toMatchObject({ ok: false, reason: 'issue-mismatch' });
    if (!result.ok) expect(result.detail).toContain('#99');
  });

  it('allows checkout-only actions for successful issue-cruncher jobs', () => {
    expect(canExecuteAgentActions(
      { kind: 'agent:issue-cruncher', exitCode: 0, ghIssueNumber: null },
      [{ type: 'checkout-default' }],
    )).toEqual({ ok: true });
  });
});
