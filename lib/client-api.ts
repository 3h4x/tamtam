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
  fixCi,
  reviewProject,
  releaseProject,
  testProject,
  fetchIssuesAndPRs,
  mergePR,
  approvePR,
  reviewPR,
  fetchPersonas,
  runProject,
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
  updateProjectConfig,
  fetchCustomActions,
  saveCustomActions,
  runCustomAction,
  fetchProjectDocs,
  fetchRecommendationsSummary,
  fetchAllOpenRecommendations,
  updateRecommendation,
  applyRecommendation,
  AUTO_APPLICABLE_RECOMMENDATION_TYPES,
} from './client/projects'
export type { RecommendationsSummary } from './client/projects'

export {
  fetchJobs,
  fetchNotifications,
  markJobSeen,
  markNotificationsSeen,
  syncJobBoard,
} from './client/jobs'

export {
  fetchAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  runAgent,
  improveAgentPrompt,
} from './client/agents'

export type { RunAgentResult, ImprovePromptInput } from './client/agents'

export {
  fetchSkills,
  createSkill,
  updateSkill,
  deleteSkill,
} from './client/skills'
