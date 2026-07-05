import { describe, it, expect } from 'vitest';
import { inboxSignalToItem, recommendationToItem, mergeAttention, countAttention } from '@/lib/attention/map';
import { recommendationActions } from '@/lib/attention/recommendation-actions';
import type { AttentionItem } from '@/lib/attention/types';
import type { InboxSignal } from '@/lib/workflows/inbox';
import type { RecommendationRow } from '@/lib/recommendations/recommendations';

const rec = (o: Partial<RecommendationRow> & { type: string }): RecommendationRow => ({
  id: 'r',
  project: 'p',
  source_kind: 'run',
  source_id: 'j1',
  agent_id: 'a1',
  agent_name: 'a',
  title: 't',
  detail: 'd',
  status: 'open',
  payload: { enabled: true },
  created_at: 0,
  updated_at: 0,
  ...o,
});

const sig = (o: Partial<InboxSignal> & { id: string; severity: InboxSignal['severity'] }): InboxSignal => ({
  type: 'ci_red',
  project: 'p',
  title: 't',
  detail: null,
  href: '/x',
  externalUrl: null,
  ageSeconds: 0,
  action: { kind: 'fix-ci', label: 'Fix' },
  ...o,
});

const recItem = (o: Partial<AttentionItem> & { id: string; severity: AttentionItem['severity'] }): AttentionItem => ({
  source: 'recommendation',
  project: 'p',
  title: 'r',
  detail: null,
  ageSeconds: 10,
  href: '/p',
  externalUrl: null,
  actions: [],
  agent: null,
  dismissible: true,
  ...o,
});

describe('inboxSignalToItem', () => {
  it('maps a signal to a non-dismissible, single-action, agentless item with a namespaced id', () => {
    const item = inboxSignalToItem(sig({ id: 'ci_red:p', severity: 'red' }));
    expect(item).toMatchObject({
      id: 'signal:ci_red:p',
      source: 'signal',
      project: 'p',
      severity: 'red',
      agent: null,
      dismissible: false,
    });
    expect(item.actions).toHaveLength(1);
    expect(item.actions[0]).toMatchObject({ kind: 'fix-ci', label: 'Fix' });
  });

  it('carries a PR-scoped action prNumber through', () => {
    const item = inboxSignalToItem(
      sig({ id: 'pr_needs_manual_merge:p:76', severity: 'red', action: { kind: 'merge', label: 'Merge', prNumber: 76 } }),
    );
    expect(item.actions[0]).toMatchObject({ kind: 'merge', prNumber: 76 });
  });
});

describe('mergeAttention', () => {
  it('sorts red signal above a yellow rec above a green rec, then counts', () => {
    const { items, counts } = mergeAttention(
      [sig({ id: 'ci_red:p', severity: 'red' })],
      [recItem({ id: 'rec:2', severity: 'green' }), recItem({ id: 'rec:1', severity: 'yellow' })],
    );
    expect(items.map((i) => i.severity)).toEqual(['red', 'yellow', 'green']);
    expect(counts).toEqual({ red: 1, yellow: 1, green: 1, total: 3 });
  });

  it('within a severity, sorts oldest-first (larger ageSeconds first)', () => {
    const { items } = mergeAttention(
      [],
      [
        recItem({ id: 'rec:new', severity: 'yellow', ageSeconds: 5 }),
        recItem({ id: 'rec:old', severity: 'yellow', ageSeconds: 500 }),
      ],
    );
    expect(items.map((i) => i.id)).toEqual(['rec:old', 'rec:new']);
  });
});

describe('countAttention', () => {
  it('tallies by severity with a total', () => {
    expect(
      countAttention([
        recItem({ id: 'a', severity: 'red' }),
        recItem({ id: 'b', severity: 'red' }),
        recItem({ id: 'c', severity: 'green' }),
      ]),
    ).toEqual({ red: 2, yellow: 0, green: 1, total: 3 });
  });
});

describe('recommendationActions', () => {
  it('returns dismiss-only for an AUTO recommendation (orchestrator_boost)', () => {
    expect(recommendationActions(rec({ type: 'orchestrator_boost' })).map((a) => a.kind)).toEqual(['dismiss']);
  });

  it('offers apply for the auto-applicable schedule-backoff type', () => {
    const kinds = recommendationActions(
      rec({ type: 'agent_schedule_backoff', payload: { enabled: true, currentSchedule: '*/15 * * * *', recommendedSchedule: '0 * * * *' } }),
    ).map((a) => a.kind);
    expect(kinds).toContain('apply');
    expect(kinds).toContain('dismiss');
  });

  it('offers investigate/disable/edit/improve for a MANUAL unfruitful rec on an editable agent', () => {
    const kinds = recommendationActions(rec({ type: 'agent_unfruitful', payload: { enabled: true, cause: 'noise' } })).map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['investigate', 'disable', 'edit-agent', 'improve-prompt', 'dismiss']));
  });

  it('omits agent actions for a system agent id (not user-editable)', () => {
    const kinds = recommendationActions(rec({ type: 'agent_unfruitful', agent_id: 'system:health', payload: { enabled: true } })).map((a) => a.kind);
    expect(kinds).not.toContain('disable');
    expect(kinds).not.toContain('investigate');
  });

  it('carries the target schedule as payloadArg on decrease-rate', () => {
    const acts = recommendationActions(rec({ type: 'agent_unfruitful', payload: { enabled: true, currentSchedule: '*/15 * * * *' } }));
    const dec = acts.find((a) => a.kind === 'decrease-rate');
    expect(dec?.payloadArg).toBeTruthy();
  });
});

describe('recommendationToItem', () => {
  it('maps a MANUAL rec → yellow, dismissible item with agent + namespaced id', () => {
    const item = recommendationToItem(rec({ type: 'agent_unfruitful', payload: { enabled: true } }));
    expect(item).toMatchObject({ id: 'rec:r', source: 'recommendation', severity: 'yellow', dismissible: true });
    expect(item.agent).toEqual({ id: 'a1', name: 'a' });
    expect(item.actions.some((a) => a.kind === 'dismiss')).toBe(true);
  });

  it('maps an AUTO rec → green', () => {
    expect(recommendationToItem(rec({ type: 'orchestrator_boost' })).severity).toBe('green');
  });
});
