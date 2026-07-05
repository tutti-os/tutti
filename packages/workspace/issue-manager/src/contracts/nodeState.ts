import type { IssueManagerStatus } from "./domain.ts";

export interface IssueManagerNodeState {
  activeTopicId?: string | null;
  issueDraftContent?: string | null;
  issueDraftTitle?: string | null;
  issueListNextPageToken?: string | null;
  issueSearchQuery: string;
  issueStatusFilter: IssueManagerStatus | "all";
  selectedAgentTargetId: string;
  selectedExecutionDirectory?: string | null;
  selectedIssueId: string | null;
  selectedTaskId: string | null;
  taskDraftContent?: string | null;
  taskDraftTitle?: string | null;
  taskListCollapsed?: boolean | null;
  taskListNextPageToken?: string | null;
}
