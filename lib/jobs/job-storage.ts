// Compatibility barrel for callers that import the job-storage facade.

export type { JobData } from './types';

export { readLog, readLogHead, readParsedLog, readDisplayLog, getVerdict } from './verdict';

export {
  runWithParent,
  jobsCache,
  loadFromDb,
  saveToDbAsync,
  saveToDb,
  findActiveReleaseJob,
  createJob,
  getJob,
  listJobs,
  unseenFinished,
  markSeen,
  markAllUnseenFinished,
  updateJob,
  jobToDict,
  jobToListDict,
  persistVerdict,
} from './storage';

export { markDone, runCompletionHooks, PIPELINE_STEP_KINDS } from './lifecycle';

export { probeJobStatus } from './probe';
