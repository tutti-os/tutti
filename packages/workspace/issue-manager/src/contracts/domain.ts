export type IssueManagerStatus =
  | "not_started"
  | "running"
  | "pending_acceptance"
  | "completed"
  | "failed"
  | "canceled"
  | (string & {});

export type IssueManagerTaskStatusUpdate =
  | "completed"
  | "not_started"
  | "pending_acceptance";

export type IssueManagerPriority = "high" | "medium" | "low" | (string & {});

export type IssueManagerContextRefParentKind = "issue" | "task";

export interface IssueManagerScope {
  workspaceId: string;
}

export interface IssueManagerStatusCounts {
  all: number;
  notStarted: number;
  running: number;
  pendingAcceptance: number;
  completed: number;
  failed: number;
  canceled: number;
}

export interface IssueManagerTopic {
  topicId: string;
  workspaceId: string;
  title: string;
  summary: string;
  isDefault: boolean;
  pinnedAtUnix?: number;
  lastActivityAtUnix?: number;
  createdAtUnix?: number;
  updatedAtUnix?: number;
}

export interface IssueManagerIssueSummary {
  issueId: string;
  workspaceId: string;
  topicId: string;
  title: string;
  content?: string;
  status: IssueManagerStatus;
  taskCount?: number;
  notStartedCount?: number;
  runningCount?: number;
  pendingAcceptanceCount?: number;
  completedCount?: number;
  failedCount?: number;
  canceledCount?: number;
  creatorUserId: string;
  creatorDisplayName?: string;
  creatorAvatarUrl?: string;
  createdAtUnix?: number;
  updatedAtUnix?: number;
}

export interface IssueManagerTaskSummary {
  taskId: string;
  issueId: string;
  workspaceId: string;
  title: string;
  content?: string;
  status: IssueManagerStatus;
  priority: IssueManagerPriority;
  sortIndex?: number;
  dueAtUnix?: number;
  creatorUserId: string;
  creatorDisplayName?: string;
  creatorAvatarUrl?: string;
  latestRunId?: string;
  createdAtUnix?: number;
  updatedAtUnix?: number;
}

export interface IssueManagerRun {
  runId: string;
  taskId?: string;
  issueId: string;
  workspaceId: string;
  requesterUserId: string;
  agentUserId: string;
  agentTargetId?: string | null;
  agentSessionId?: string;
  agentProvider: string;
  status: IssueManagerStatus;
  summary?: string;
  errorMessage?: string;
  outputDir?: string;
  executionDirectory?: string;
  createdAtUnix?: number;
  startedAtUnix?: number;
  completedAtUnix?: number;
  updatedAtUnix?: number;
}

export interface IssueManagerRunOutput {
  outputId: string;
  runId: string;
  taskId?: string;
  issueId: string;
  workspaceId: string;
  path: string;
  displayName: string;
  mediaType?: string;
  sizeBytes?: number;
  createdAtUnix?: number;
}

interface IssueManagerContextRefBase {
  contextRefId: string;
  workspaceId: string;
  issueId: string;
  refType: string;
  path: string;
  displayName: string;
  createdAtUnix?: number;
}

export interface IssueManagerIssueContextRef extends IssueManagerContextRefBase {
  parentKind: "issue";
}

export interface IssueManagerTaskContextRef extends IssueManagerContextRefBase {
  parentKind: "task";
  taskId: string;
}

export type IssueManagerContextRef =
  | IssueManagerIssueContextRef
  | IssueManagerTaskContextRef;

export interface IssueManagerIssueDetail {
  issue: IssueManagerIssueSummary;
  tasks: IssueManagerTaskSummary[];
  contextRefs: IssueManagerContextRef[];
  latestRun?: IssueManagerRun | null;
  recentRuns: IssueManagerRun[];
  latestOutputs: IssueManagerRunOutput[];
}

export interface IssueManagerTaskDetail {
  task: IssueManagerTaskSummary;
  contextRefs: IssueManagerContextRef[];
  latestRun?: IssueManagerRun | null;
  recentRuns: IssueManagerRun[];
  latestOutputs: IssueManagerRunOutput[];
}

export interface IssueManagerListIssuesInput extends IssueManagerScope {
  pageSize?: number;
  pageToken?: string;
  searchQuery?: string;
  statusFilter?: IssueManagerStatus | "all";
  topicId: string;
}

export interface IssueManagerListIssuesResult {
  issues: IssueManagerIssueSummary[];
  nextPageToken?: string;
  statusCounts?: IssueManagerStatusCounts;
  totalCount?: number;
}

export interface IssueManagerListTasksInput extends IssueManagerScope {
  issueId: string;
  pageSize?: number;
  pageToken?: string;
  searchQuery?: string;
  statusFilter?: IssueManagerStatus | "all";
}

export interface IssueManagerListTasksResult {
  nextPageToken?: string;
  statusCounts?: IssueManagerStatusCounts;
  tasks: IssueManagerTaskSummary[];
  totalCount?: number;
}

export interface IssueManagerCreateIssueInput extends IssueManagerScope {
  content?: string;
  issueId?: string;
  title: string;
  topicId: string;
}

export interface IssueManagerUpdateIssueInput extends IssueManagerScope {
  content?: string;
  issueId: string;
  title?: string;
}

export interface IssueManagerListTopicsResult {
  topics: IssueManagerTopic[];
}

export interface IssueManagerCreateTopicInput extends IssueManagerScope {
  summary?: string;
  title: string;
  topicId?: string;
}

export interface IssueManagerUpdateTopicInput extends IssueManagerScope {
  pinned?: boolean;
  summary?: string;
  title?: string;
  topicId: string;
}

export interface IssueManagerCreateTaskInput extends IssueManagerScope {
  content?: string;
  dueAtUnix?: number;
  issueId: string;
  priority?: IssueManagerPriority;
  taskId?: string;
  title: string;
}

export interface IssueManagerUpdateTaskInput extends IssueManagerScope {
  content?: string;
  dueAtUnix?: number;
  issueId: string;
  priority?: IssueManagerPriority;
  sortIndex?: number;
  status?: IssueManagerStatus;
  taskId: string;
  title?: string;
}

export interface IssueManagerAddContextRefInput {
  displayName?: string;
  path: string;
  refType: string;
}

interface IssueManagerAddContextRefsInputBase extends IssueManagerScope {
  issueId: string;
  refs: IssueManagerAddContextRefInput[];
}

export type IssueManagerAddContextRefsInput =
  | (IssueManagerAddContextRefsInputBase & { parentKind: "issue" })
  | (IssueManagerAddContextRefsInputBase & {
      parentKind: "task";
      taskId: string;
    });

export interface IssueManagerCreateRunInput extends IssueManagerScope {
  agentProvider?: string;
  agentSessionId?: string;
  agentTargetId?: string;
  agentUserId?: string;
  executionDirectory?: string;
  issueId: string;
  runId?: string;
  taskId?: string;
}

export interface IssueManagerCompleteRunOutputInput {
  displayName?: string;
  mediaType?: string;
  outputId?: string;
  path: string;
  sizeBytes?: number;
}

export type IssueManagerRunCompletionStatus = Extract<
  IssueManagerStatus,
  "completed" | "failed" | "canceled"
>;

export interface IssueManagerCompleteRunInput extends IssueManagerScope {
  errorMessage?: string;
  issueId: string;
  outputs: IssueManagerCompleteRunOutputInput[];
  runId: string;
  status: IssueManagerRunCompletionStatus;
  summary?: string;
  taskId?: string;
}

export interface IssueManagerRunEnvelope {
  outputs: IssueManagerRunOutput[];
  run: IssueManagerRun;
}

export type IssueManagerRemoveContextRefInput =
  | (IssueManagerScope & {
      contextRefId: string;
      issueId: string;
      parentKind: "issue";
    })
  | (IssueManagerScope & {
      contextRefId: string;
      issueId: string;
      parentKind: "task";
      taskId: string;
    });
