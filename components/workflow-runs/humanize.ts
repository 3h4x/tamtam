// Turn machine workflow/step function names into operator-readable labels.
//
// The workflow runtime records names like
// `workflow//./lib/workflows/agents/intake-workflow//runAgentIntakeWorkflow`,
// which the API simplifies to the last segment (`runAgentIntakeWorkflow`).
// Operators don't think in function names — they think "an agent ran" or
// "the release pipeline is on the review phase". This maps the known
// vocabulary to plain language and falls back to a generic de-camelize for
// anything new, so a freshly added workflow still reads sensibly without a
// code change here.

// Tokens that should keep their canonical casing when the generic fallback
// rebuilds a label from camelCase.
const ACRONYMS: Record<string, string> = {
  ci: 'CI',
  dod: 'DoD',
  pr: 'PR',
  qa: 'QA',
};

// Curated labels for the workflows and steps that actually show up in the
// release pipeline and scheduling surfaces. Keep these short — they sit in a
// dense table column.
const KNOWN_LABELS: Record<string, string> = {
  // Top-level workflows
  releaseWorkflow: 'Release',
  releaseOrchestratorWorkflow: 'Release pipeline',
  dispatchReleaseWorkflow: 'Dispatch release',
  dispatchReleaseAfterRun: 'Continue release',
  dispatchReleaseAfterFixCi: 'Continue release after CI fix',
  runAgentIntakeWorkflow: 'Agent run',
  handleAgentCron: 'Scheduled agent',
  handleOrchestratorTick: 'Pipeline check',
  handleProjectSweep: 'Project sweep',
  handlePipelineStep: 'Pipeline step',
  seedAgentCronsWorkflow: 'Sync agent schedules',
  waitForJobCompletion: 'Wait for job',
  pruneOldWorkflowRuns: 'Prune old runs',
  safeStartOrchestrator: 'Start pipeline',

  // Release phase workflows
  releaseTestPhaseWorkflow: 'Test',
  releaseReviewPhaseWorkflow: 'Review',
  releaseFixPhaseWorkflow: 'Fix',
  releaseCommitPhaseWorkflow: 'Commit',
  releasePushPhaseWorkflow: 'Push',
  releaseMarkDodPhaseWorkflow: 'Mark done',
  releasePrWaitPhaseWorkflow: 'Wait for PR',
  releaseSoakPhaseWorkflow: 'Soak',

  // Common steps
  decideNextPhaseStep: 'Decide next phase',
  readReviewVerdictStep: 'Read review verdict',
  waitForJobStep: 'Wait for job',
  kickoffReleaseStep: 'Kick off release',
  dispatchOrchestratorStep: 'Dispatch pipeline',
};

function genericLabel(raw: string): string {
  // Drop runtime suffixes/prefixes that carry no meaning for an operator.
  const stripped = raw
    .replace(/(Workflow|Step|Task)$/i, '')
    .replace(/^handle/, '');
  const words = stripped
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return raw;
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (ACRONYMS[lower]) return ACRONYMS[lower];
      if (index === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
      return lower;
    })
    .join(' ');
}

/**
 * Human label for a (already simplified) workflow or step name.
 * Handles the runtime's `_phase` / `_phase_N` sub-step suffixes by labelling
 * the base workflow and appending a 1-based phase number.
 */
export function humanizeWorkflowLabel(simplifiedName: string): string {
  if (!simplifiedName) return 'Workflow';
  if (/^[a-z][a-z0-9]*(?:[ _-][a-z0-9]+)*$/.test(simplifiedName)) {
    return simplifiedName.replace(/[_-]+/g, ' ');
  }

  let base = simplifiedName;
  let suffix = '';
  const phaseN = simplifiedName.match(/^(.*?)_phase_(\d+)$/);
  const phase = simplifiedName.match(/^(.*?)_phase$/);
  if (phaseN) {
    base = phaseN[1];
    suffix = ` · phase ${Number(phaseN[2]) + 1}`;
  } else if (phase) {
    base = phase[1];
    suffix = ' · phase';
  }

  const label = KNOWN_LABELS[base] ?? genericLabel(base);
  return `${label}${suffix}`;
}

// Runtime error messages embed raw loader paths, e.g.
// `Step "step//./lib/workflows/phases/test-phase//runReleaseTestPhaseStep" failed: …`.
// Operators shouldn't have to read those — replace each embedded
// `kind//…//name` token with its human label so the surrounding message
// ("Step "Run release test phase" failed: …") stays intact and readable.
const EMBEDDED_LOADER_PATH = /\b(?:workflow|step|task)\/\/[^\s"']*\/\/[A-Za-z_$][\w$]*(?=\b|$)/g;

export function humanizeEmbeddedNames(text: string): string {
  if (!text || !text.includes('//')) return text;
  return text.replace(EMBEDDED_LOADER_PATH, (token) => {
    const segments = token.split('//').filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last) return token;
    return humanizeWorkflowLabel(last);
  });
}
