// Barrel file: re-exports everything from the split modules under lib/client/
// so all existing `import ... from '@/lib/client-api'` imports continue to work unchanged.

export type { Task, ProjectsResponse } from '@/lib/shared/types'
export type {
  RunHistoryEntry,
  TaskDetail,
  GhLabel,
  GhAuthor,
  GhPullRequest,
  GhIssue,
  IssuesResponse,
  Persona,
  RunProjectOptions,
  LogEntry,
  ChangeStatus,
  ChangeFile,
  ChangesResponse,
  ChangeDiffResponse,
  ProjectConfig,
  ProjectSetupStatus,
  ProjectSetupState,
  ProjectSetupStep,
  PipelineDurationStats,
  ProjectPipelineStats,
  JobInfo,
  ModifiedFileSummary,
  Recommendation,
  CustomAction,
  Skill,
  Agent,
  ProjectDoc,
  MarkDodResult,
} from './client/types'

export { API_BASE } from './client/projects'

export {
  fetchProjects,
  setPriority,
  pauseProject,
  resumeProject,
  fetchTaskDetail,
  fetchProjectPipelineStats,
  fixCi,
  reviewProject,
  releaseProject,
  fetchReleasePlan,
  testProject,
  fetchIssuesAndPRs,
  fetchIssuesSummary,
  mergePR,
  resolveConflicts,
  approvePR,
  closeIssue,
  reviewPR,
  addressPrComments,
  fetchPersonas,
  runProject,
  isQueuedRunResult,
  fetchProjectLogs,
  pushProject,
  checkoutDefaultBranch,
  fetchChanges,
  fetchBehind,
  fetchBranch,
  createProjectPR,
  CreatePRPrePushHookError,
  runMarkDod,
  PullDivergedError,
  pullProject,
  fetchChangeDiff,
  fetchProjectConfig,
  fetchProjectSetup,
  updateProjectSetup,
  updateProjectConfig,
  fetchCustomActions,
  saveCustomActions,
  runCustomAction,
  fetchProjectDocs,
  fetchRecommendationsSummary,
  fetchAllOpenRecommendations,
  fetchRecommendationsHistory,
  updateRecommendation,
  applyRecommendation,
  AUTO_APPLICABLE_RECOMMENDATION_TYPES,
  AUTO_RECOMMENDATION_TYPES,
  MANUAL_RECOMMENDATION_TYPES,
  isAutoRecommendation,
  isManualRecommendation,
} from './client/projects'
export type { RecommendationsSummary, RunProjectResult, RunQueuedResult, RunStartedResult } from './client/projects'

export { patchInitiative } from './client/initiatives'
export type { InitiativeAction } from './client/initiatives'

export {
  fetchJobs,
  fetchNotifications,
  markJobSeen,
  markNotificationsSeen,
  syncJobBoard,
  continueJob,
} from './client/jobs'

export {
  fetchAutomationQueue,
  retryAutomationQueue,
  cancelAutomationQueueItem,
} from './client/automation-queue'
export type { AutomationQueueItem, RetryAutomationQueueResult } from './client/automation-queue'

export { fetchInbox } from './client/inbox'
export { fetchSettings, invalidateSettings } from './client/settings'
export type {
  InboxSignal,
  InboxSignalType,
  InboxSeverity,
  InboxAction,
  InboxActionKind,
  InboxCounts,
  InboxResponse,
} from './client/inbox'

export {
  fetchAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  runAgent,
  improveAgentPrompt,
  fetchAgentRevisions,
  revertAgent,
} from './client/agents'

export type { RunAgentResult, ImprovePromptInput } from './client/agents'

export {
  fetchSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  fetchSkillRevisions,
  revertSkill,
} from './client/skills'

export type { SkillRevision, AgentRevision } from './client/types'
