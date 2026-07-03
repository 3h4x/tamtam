// Ephemeral per-project bound for the sweep's auto fix-ci trigger.
//
// The sweep auto-dispatches a `fix-ci` when a project's DEFAULT branch CI is
// red (see `decideSweepAction`). Without a bound that loops forever: fix-ci →
// release → new default-branch run → still red → fix-ci again, burning budget
// on a CI that a code fix can't (or won't) resolve.
//
// The bound is keyed on the failing default-branch run URL (stable per failed
// run; a new commit/push produces a new run URL):
//   * the SAME failing run is only attempted ONCE — re-seeing it means the last
//     attempt didn't land a merge (or didn't fix it), so re-dispatching is
//     futile; skip and let the `ci_red` inbox HITL carry it.
//   * across DISTINCT failing runs (each fix produced a new, still-red commit)
//     the attempt counter caps the run so a structurally-broken CI can't spin.
//
// State is intentionally in-memory on `globalThis` (Next.js duplicates module
// realms) like the other ephemeral loop throttles (`__tamtamReinforceState`,
// `__tamtamInitiativeLastMine`). A restart resets it — worst case a couple of
// extra attempts after a restart, still bounded, never an infinite loop.

const DEFAULT_MAX_ATTEMPTS = 3;

export function getAutoFixCiMaxAttempts(): number {
  const raw = parseInt(process.env.TAMTAM_AUTO_FIX_CI_MAX_ATTEMPTS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_ATTEMPTS;
}

export interface AutoFixCiEntry {
  /** Failing default-branch run URL we last dispatched a fix-ci for. */
  lastFailureKey: string | null;
  /** Consecutive distinct-failure auto-fix attempts since the last green. */
  attempts: number;
}

export interface AutoFixCiDecision {
  dispatch: boolean;
  reason: string;
  /** The entry to persist when `dispatch` is true. */
  next?: AutoFixCiEntry;
}

/**
 * Pure decision: given the current per-project entry and the failing run key,
 * decide whether the sweep should dispatch another auto fix-ci. Exported for
 * unit testing — no globals touched here.
 */
export function decideAutoFixCi(
  entry: AutoFixCiEntry | undefined,
  failureKey: string | null,
  maxAttempts: number,
): AutoFixCiDecision {
  const key = (failureKey ?? '').trim();
  if (!key) {
    return { dispatch: false, reason: 'no failing-run URL — cannot bound auto fix-ci' };
  }
  const cur: AutoFixCiEntry = entry ?? { lastFailureKey: null, attempts: 0 };
  if (cur.lastFailureKey === key) {
    return { dispatch: false, reason: 'already auto-fixed this failing run — leaving red CI for the inbox HITL' };
  }
  if (cur.attempts >= maxAttempts) {
    return { dispatch: false, reason: `auto fix-ci attempt cap ${maxAttempts} reached — leaving red CI for the inbox HITL` };
  }
  return {
    dispatch: true,
    reason: `default-branch CI red — auto fix-ci (attempt ${cur.attempts + 1}/${maxAttempts})`,
    next: { lastFailureKey: key, attempts: cur.attempts + 1 },
  };
}

type AutoFixCiStore = Map<string, AutoFixCiEntry>;

function store(): AutoFixCiStore {
  const g = globalThis as unknown as { __tamtamAutoFixCiState?: AutoFixCiStore };
  if (!g.__tamtamAutoFixCiState) g.__tamtamAutoFixCiState = new Map();
  return g.__tamtamAutoFixCiState;
}

export function getAutoFixCiEntry(project: string): AutoFixCiEntry | undefined {
  return store().get(project);
}

export function setAutoFixCiEntry(project: string, entry: AutoFixCiEntry): void {
  store().set(project, entry);
}

/** Reset a project's bound — called when its default branch CI goes green so a
 *  future red failure starts with a fresh attempt budget. */
export function clearAutoFixCiEntry(project: string): void {
  store().delete(project);
}
