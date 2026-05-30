import { describe, expect, it } from 'vitest';
import { humanizeWorkflowLabel, humanizeEmbeddedNames } from '@/components/workflow-runs/humanize';

describe('humanizeWorkflowLabel', () => {
  it('maps known workflows to plain labels', () => {
    expect(humanizeWorkflowLabel('runAgentIntakeWorkflow')).toBe('Agent run');
    expect(humanizeWorkflowLabel('releaseOrchestratorWorkflow')).toBe('Release pipeline');
    expect(humanizeWorkflowLabel('handleAgentCron')).toBe('Scheduled agent');
    expect(humanizeWorkflowLabel('handleOrchestratorTick')).toBe('Pipeline check');
  });

  it('appends a 1-based phase number for _phase_N sub-steps', () => {
    expect(humanizeWorkflowLabel('releaseWorkflow_phase_0')).toBe('Release · phase 1');
    expect(humanizeWorkflowLabel('releaseWorkflow_phase_3')).toBe('Release · phase 4');
  });

  it('handles the bare _phase suffix', () => {
    expect(humanizeWorkflowLabel('releaseOrchestratorWorkflow_phase')).toBe('Release pipeline · phase');
  });

  it('falls back to a de-camelized sentence for unknown names', () => {
    expect(humanizeWorkflowLabel('handleProjectSweep')).toBe('Project sweep');
    expect(humanizeWorkflowLabel('someBrandNewWorkflow')).toBe('Some brand new');
  });

  it('preserves simple lower-case workflow names that are already readable', () => {
    expect(humanizeWorkflowLabel('release')).toBe('release');
    expect(humanizeWorkflowLabel('release-test')).toBe('release test');
    expect(humanizeWorkflowLabel('release_test')).toBe('release test');
  });

  it('preserves known acronyms in the generic fallback', () => {
    expect(humanizeWorkflowLabel('handleCiRetryStep')).toBe('CI retry');
  });

  it('is safe on empty input', () => {
    expect(humanizeWorkflowLabel('')).toBe('Workflow');
  });
});

describe('humanizeEmbeddedNames', () => {
  it('replaces an embedded loader path with its human label', () => {
    const raw = 'Step "step//./lib/workflows/phases/test-phase//runReleaseTestPhaseStep" failed: project boom';
    expect(humanizeEmbeddedNames(raw)).toBe('Step "Run release test phase" failed: project boom');
  });

  it('humanizes a known workflow path', () => {
    const raw = 'workflow//./lib/workflows/agents/intake-workflow//runAgentIntakeWorkflow';
    expect(humanizeEmbeddedNames(raw)).toBe('Agent run');
  });

  it('leaves plain messages untouched', () => {
    expect(humanizeEmbeddedNames('project build failed: exit 1')).toBe('project build failed: exit 1');
  });

  it('leaves URLs in error text untouched', () => {
    const raw = 'fetch failed for https://example.test/workflow//runs: HTTP 500';
    expect(humanizeEmbeddedNames(raw)).toBe(raw);
  });

  it('is safe on empty input', () => {
    expect(humanizeEmbeddedNames('')).toBe('');
  });
});
