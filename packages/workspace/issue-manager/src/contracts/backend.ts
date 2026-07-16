import type {
  IssueManagerAddContextRefsInput,
  IssueManagerCompleteRunInput,
  IssueManagerContextRef,
  IssueManagerCreateTopicInput,
  IssueManagerCreateIssueInput,
  IssueManagerCreateIssueFromPlanInput,
  IssueManagerCreateRunInput,
  IssueManagerCreateTaskInput,
  IssueManagerIssueDetail,
  IssueManagerIssueSummary,
  IssueManagerListIssuesInput,
  IssueManagerListIssuesResult,
  IssueManagerListTopicsResult,
  IssueManagerListTasksInput,
  IssueManagerListTasksResult,
  IssueManagerRemoveContextRefInput,
  IssueManagerRun,
  IssueManagerRunEnvelope,
  IssueManagerScope,
  IssueManagerTaskDetail,
  IssueManagerTaskSummary,
  IssueManagerTopic,
  IssueManagerUpdateIssueInput,
  IssueManagerUpdateTaskInput,
  IssueManagerUpdateTopicInput
} from "./domain.ts";

export interface IssueManagerBackend {
  addContextRefs(
    input: IssueManagerAddContextRefsInput
  ): Promise<IssueManagerContextRef[]>;
  completeRun(
    input: IssueManagerCompleteRunInput
  ): Promise<IssueManagerRunEnvelope>;
  createIssue(
    input: IssueManagerCreateIssueInput
  ): Promise<IssueManagerIssueSummary>;
  createIssueFromPlan?(
    input: IssueManagerCreateIssueFromPlanInput
  ): Promise<IssueManagerIssueDetail>;
  createTopic(input: IssueManagerCreateTopicInput): Promise<IssueManagerTopic>;
  createRun(input: IssueManagerCreateRunInput): Promise<IssueManagerRun>;
  createTask(
    input: IssueManagerCreateTaskInput
  ): Promise<IssueManagerTaskSummary>;
  deleteIssue(
    input: IssueManagerScope & { issueId: string }
  ): Promise<{ removed: boolean }>;
  deleteTask(
    input: IssueManagerScope & { issueId: string; taskId: string }
  ): Promise<{ removed: boolean }>;
  deleteTopic(
    input: IssueManagerScope & { topicId: string }
  ): Promise<{ removed: boolean }>;
  getIssueDetail(
    input: IssueManagerScope & { issueId: string }
  ): Promise<IssueManagerIssueDetail>;
  getTaskDetail(
    input: IssueManagerScope & { issueId: string; taskId: string }
  ): Promise<IssueManagerTaskDetail>;
  listIssues(
    input: IssueManagerListIssuesInput
  ): Promise<IssueManagerListIssuesResult>;
  listTasks(
    input: IssueManagerListTasksInput
  ): Promise<IssueManagerListTasksResult>;
  listTopics(input: IssueManagerScope): Promise<IssueManagerListTopicsResult>;
  removeContextRef(
    input: IssueManagerRemoveContextRefInput
  ): Promise<{ removed: boolean }>;
  updateIssue(
    input: IssueManagerUpdateIssueInput
  ): Promise<IssueManagerIssueSummary>;
  updateTask(
    input: IssueManagerUpdateTaskInput
  ): Promise<IssueManagerTaskSummary>;
  updateTopic(input: IssueManagerUpdateTopicInput): Promise<IssueManagerTopic>;
}
