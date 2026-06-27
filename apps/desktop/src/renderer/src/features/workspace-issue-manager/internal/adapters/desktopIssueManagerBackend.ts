import type {
  IssueManagerIssueDetailResponse,
  IssueManagerTask,
  IssueManagerTaskDetailResponse,
  IssueManagerTaskListResponse,
  IssueManagerTopicListResponse,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import type {
  IssueManagerBackend,
  IssueManagerIssueDetail,
  IssueManagerListTasksResult,
  IssueManagerTaskDetail,
  IssueManagerTaskSummary
} from "@tutti-os/workspace-issue-manager/contracts";

export function createDesktopIssueManagerBackend(
  tuttidClient: TuttidClient
): IssueManagerBackend {
  return {
    async addContextRefs(input) {
      if (input.parentKind === "task") {
        const response = await tuttidClient.addWorkspaceIssueTaskContextRefs(
          input.workspaceId,
          input.issueId,
          input.taskId,
          {
            refs: input.refs
          }
        );
        return response.contextRefs;
      }

      const response = await tuttidClient.addWorkspaceIssueContextRefs(
        input.workspaceId,
        input.issueId,
        {
          refs: input.refs
        }
      );
      return response.contextRefs;
    },
    async completeRun(input) {
      const taskId = input.taskId?.trim();
      if (!taskId) {
        return tuttidClient.completeWorkspaceIssueRun(
          input.workspaceId,
          input.issueId,
          input.runId,
          {
            errorMessage: input.errorMessage,
            outputs: input.outputs,
            status: input.status,
            summary: input.summary
          }
        );
      }
      return tuttidClient.completeWorkspaceIssueTaskRun(
        input.workspaceId,
        input.issueId,
        taskId,
        input.runId,
        {
          errorMessage: input.errorMessage,
          outputs: input.outputs,
          status: input.status,
          summary: input.summary
        }
      );
    },
    async createIssue(input) {
      return tuttidClient.createWorkspaceIssue(input.workspaceId, {
        content: input.content,
        issueId: input.issueId,
        topicId: input.topicId,
        title: input.title
      });
    },
    async createTopic(input) {
      return tuttidClient.createWorkspaceIssueTopic(input.workspaceId, {
        summary: input.summary,
        title: input.title,
        topicId: input.topicId
      });
    },
    async createRun(input) {
      const taskId = input.taskId?.trim();
      if (!taskId) {
        const executionDirectory = input.executionDirectory?.trim();
        return tuttidClient.createWorkspaceIssueRun(
          input.workspaceId,
          input.issueId,
          {
            agentProvider: input.agentProvider,
            agentSessionId: input.agentSessionId,
            agentUserId: input.agentUserId,
            ...(executionDirectory ? { executionDirectory } : {}),
            runId: input.runId
          }
        );
      }
      const executionDirectory = input.executionDirectory?.trim();
      return tuttidClient.createWorkspaceIssueTaskRun(
        input.workspaceId,
        input.issueId,
        taskId,
        {
          agentProvider: input.agentProvider,
          agentSessionId: input.agentSessionId,
          agentUserId: input.agentUserId,
          ...(executionDirectory ? { executionDirectory } : {}),
          runId: input.runId
        }
      );
    },
    async createTask(input) {
      const task = await tuttidClient.createWorkspaceIssueTask(
        input.workspaceId,
        input.issueId,
        {
          content: input.content,
          dueAtUnix: input.dueAtUnix,
          priority: toClientPriority(input.priority),
          taskId: input.taskId,
          title: input.title
        }
      );
      return normalizeTask(task);
    },
    async deleteIssue(input) {
      return tuttidClient.deleteWorkspaceIssue(
        input.workspaceId,
        input.issueId
      );
    },
    async deleteTask(input) {
      return tuttidClient.deleteWorkspaceIssueTask(
        input.workspaceId,
        input.issueId,
        input.taskId
      );
    },
    async deleteTopic(input) {
      return tuttidClient.deleteWorkspaceIssueTopic(
        input.workspaceId,
        input.topicId
      );
    },
    async getIssueDetail(input) {
      const response = await tuttidClient.getWorkspaceIssueDetail(
        input.workspaceId,
        input.issueId
      );
      return normalizeIssueDetail(response);
    },
    async getTaskDetail(input) {
      const response = await tuttidClient.getWorkspaceIssueTaskDetail(
        input.workspaceId,
        input.issueId,
        input.taskId
      );
      return normalizeTaskDetail(response);
    },
    async listIssues(input) {
      return tuttidClient.listWorkspaceIssues(input.workspaceId, {
        pageSize: input.pageSize,
        pageToken: input.pageToken,
        searchQuery: input.searchQuery,
        statusFilter: toClientStatusFilter(input.statusFilter),
        topicId: input.topicId
      });
    },
    async listTopics(input) {
      return normalizeTopicList(
        await tuttidClient.listWorkspaceIssueTopics(input.workspaceId)
      );
    },
    async listTasks(input) {
      const response = await tuttidClient.listWorkspaceIssueTasks(
        input.workspaceId,
        input.issueId,
        {
          pageSize: input.pageSize,
          pageToken: input.pageToken,
          searchQuery: input.searchQuery,
          statusFilter: toClientStatusFilter(input.statusFilter)
        }
      );
      return normalizeTaskList(response);
    },
    async removeContextRef(input) {
      if (input.parentKind === "task") {
        return tuttidClient.removeWorkspaceIssueTaskContextRef(
          input.workspaceId,
          input.issueId,
          input.taskId,
          input.contextRefId
        );
      }
      return tuttidClient.removeWorkspaceIssueContextRef(
        input.workspaceId,
        input.issueId,
        input.contextRefId
      );
    },
    async updateIssue(input) {
      return tuttidClient.updateWorkspaceIssue(
        input.workspaceId,
        input.issueId,
        {
          content: input.content,
          title: input.title
        }
      );
    },
    async updateTopic(input) {
      return tuttidClient.updateWorkspaceIssueTopic(
        input.workspaceId,
        input.topicId,
        {
          pinned: input.pinned,
          summary: input.summary,
          title: input.title
        }
      );
    },
    async updateTask(input) {
      const task = await tuttidClient.updateWorkspaceIssueTask(
        input.workspaceId,
        input.issueId,
        input.taskId,
        {
          content: input.content,
          dueAtUnix: input.dueAtUnix,
          priority: toClientPriority(input.priority),
          sortIndex: input.sortIndex,
          status: toClientStatus(input.status),
          title: input.title
        }
      );
      return normalizeTask(task);
    }
  };
}

function normalizeTopicList(
  response: IssueManagerTopicListResponse
): IssueManagerTopicListResponse {
  return response;
}

function normalizeIssueDetail(
  response: IssueManagerIssueDetailResponse
): IssueManagerIssueDetail {
  return {
    ...response,
    contextRefs: response.contextRefs,
    issue: response.issue,
    tasks: response.tasks.map(normalizeTask)
  };
}

function normalizeTaskDetail(
  response: IssueManagerTaskDetailResponse
): IssueManagerTaskDetail {
  return {
    ...response,
    task: normalizeTask(response.task)
  };
}

function normalizeTaskList(
  response: IssueManagerTaskListResponse
): IssueManagerListTasksResult {
  return {
    ...response,
    tasks: response.tasks.map(normalizeTask)
  };
}

function normalizeTask(task: IssueManagerTask): IssueManagerTaskSummary {
  return {
    ...task,
    taskId: requireTaskId(task.taskId)
  };
}

function requireTaskId(taskId: string | undefined): string {
  const normalized = taskId?.trim();
  if (!normalized) {
    throw new Error("Issue manager task id is required.");
  }
  return normalized;
}

function toClientPriority(
  value: string | undefined
): "high" | "medium" | "low" | undefined {
  return value === "high" || value === "medium" || value === "low"
    ? value
    : undefined;
}

function toClientStatus(
  value: string | undefined
):
  | "not_started"
  | "running"
  | "pending_acceptance"
  | "completed"
  | "failed"
  | "canceled"
  | undefined {
  switch (value) {
    case "not_started":
    case "running":
    case "pending_acceptance":
    case "completed":
    case "failed":
    case "canceled":
      return value;
    default:
      return undefined;
  }
}

function toClientStatusFilter(
  value: string | undefined
):
  | "all"
  | "not_started"
  | "running"
  | "pending_acceptance"
  | "completed"
  | "failed"
  | "canceled"
  | undefined {
  return value === "all" ? "all" : toClientStatus(value);
}
