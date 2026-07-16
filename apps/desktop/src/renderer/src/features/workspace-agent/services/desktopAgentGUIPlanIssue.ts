import type {
  AgentActivityMessage,
  AgentActivityRuntime
} from "@tutti-os/agent-gui";
import {
  planIssueDraftFromPlanText,
  type PlanIssueCreationOptions
} from "@tutti-os/agent-gui/plan-issue";
import type {
  CreateIssueManagerIssueFromPlanRequest,
  CreateIssueManagerTaskRequest,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi } from "@preload/types";

export interface DesktopAgentGUIPlanIssueResult {
  issueId: string;
  topicId: string;
  startedTaskIds: string[];
  failedTaskIds: string[];
}

export async function createDesktopIssueFromAgentPlan(input: {
  agentActivityRuntime: AgentActivityRuntime;
  agentSessionId: string;
  creationOptions?: PlanIssueCreationOptions;
  defaultIssueTitle: string;
  defaultTopicTitle: string;
  hostFilesApi?: Pick<DesktopHostFilesApi, "createGitWorktree">;
  planTurnId: string;
  tuttidClient: TuttidClient;
  workspaceId: string;
}): Promise<DesktopAgentGUIPlanIssueResult> {
  const [messagePage, session, topicList] = await Promise.all([
    input.agentActivityRuntime.listSessionMessages({
      agentSessionId: input.agentSessionId,
      limit: 200,
      order: "desc",
      workspaceId: input.workspaceId
    }),
    input.agentActivityRuntime.getSession(
      input.workspaceId,
      input.agentSessionId
    ),
    input.tuttidClient.listWorkspaceIssueTopics(input.workspaceId)
  ]);
  const planText = resolvePlanText(messagePage.messages, input.planTurnId);
  if (!planText) {
    throw new Error("agent_plan_content_unavailable");
  }
  const topic =
    topicList.topics.find((candidate) => candidate.isDefault) ??
    topicList.topics[0] ??
    (await input.tuttidClient.createWorkspaceIssueTopic(input.workspaceId, {
      title: input.defaultTopicTitle
    }));
  // Legacy plan cards do not carry creationOptions. Preserve their historical
  // create-and-start behavior; the explicit review surface sends false for the
  // create-only action.
  const startExecution = input.creationOptions?.startExecution !== false;
  const parallelExecution =
    startExecution && input.creationOptions?.executionMode === "parallel";
  let request = buildIssueFromPlanRequest({
    agentTargetId: session.agentTargetId,
    agentSessionId: input.agentSessionId,
    creationOptions: input.creationOptions,
    fallbackTitle: input.defaultIssueTitle,
    issueId: createPlanExecutionId("plan-issue"),
    parallelExecution,
    planText,
    sequentialExecution: startExecution && !parallelExecution,
    sourceDirectory: session.cwd,
    topicId: topic.topicId
  });
  if (parallelExecution) {
    request = await prepareParallelIssueExecution({
      createGitWorktree: input.hostFilesApi?.createGitWorktree,
      request,
      sourceDirectory: session.cwd
    });
  }
  const createFromPlan = input.tuttidClient.createWorkspaceIssueFromPlan;
  if (!createFromPlan) {
    throw new Error("issue_from_plan_unavailable");
  }
  const detail = await createFromPlan(input.workspaceId, request);
  const startedTaskIds = detail.tasks
    .filter((task) => task.status === "running")
    .map((task) => task.taskId);
  const failedTaskIds = detail.tasks
    .filter((task) => task.status === "failed")
    .map((task) => task.taskId);
  return {
    issueId: detail.issue.issueId,
    topicId: detail.issue.topicId,
    failedTaskIds,
    startedTaskIds
  };
}

export function buildIssueFromPlanRequest(input: {
  agentTargetId?: string | null;
  agentSessionId: string;
  creationOptions?: Pick<PlanIssueCreationOptions, "draft">;
  fallbackTitle: string;
  issueId?: string;
  parallelExecution?: boolean;
  planText: string;
  sequentialExecution?: boolean;
  sourceDirectory?: string | null;
  topicId: string;
}): CreateIssueManagerIssueFromPlanRequest {
  const draft =
    input.creationOptions?.draft ??
    planIssueDraftFromPlanText(input.planText, input.fallbackTitle);
  const taskIds = draft.tasks.map(() => createPlanTaskId());
  const sourceIds = new Map<string, string>();
  draft.tasks.forEach((task, index) => {
    const sourceId = task.sourceId.trim();
    if (!sourceId) {
      throw new Error("issue_plan_task_id_required");
    }
    if (sourceIds.has(sourceId)) {
      throw new Error("issue_plan_duplicate_task_id");
    }
    sourceIds.set(sourceId, taskIds[index] ?? "");
  });
  const tasks = draft.tasks.map((task, index) => {
    const dependencyTaskIds = task.dependencySourceIds.map((sourceId) => {
      const resolved = sourceIds.get(sourceId.trim());
      if (!resolved) {
        throw new Error("issue_plan_dependency_task_not_found");
      }
      return resolved;
    });
    const mapped: CreateIssueManagerTaskRequest = {
      taskId: taskIds[index],
      title: task.title,
      content: task.content,
      agentTargetId: task.agentTargetId ?? input.agentTargetId ?? undefined,
      modelPlanId: task.modelPlanId,
      model: task.model,
      executionDirectory: resolvePlanExecutionDirectory(
        input.sourceDirectory,
        task.executionDirectory
      ),
      dependencyTaskIds
    };
    mapped.priority = task.priority;
    return mapped;
  });
  const request: CreateIssueManagerIssueFromPlanRequest = {
    issue: {
      topicId: input.topicId,
      issueId: input.issueId,
      title: draft.title,
      content: draft.content,
      planningSource: draft.planningSource,
      sourceSessionId: input.agentSessionId,
      sequentialExecution: input.sequentialExecution === true,
      parallelExecution: input.parallelExecution === true,
      executionProfile: draft.executionProfile,
      budget: {
        mode: draft.budget.mode,
        tokenLimit: draft.budget.tokenLimit,
        consumedTokens: 0,
        quotaWaterlinePercent: draft.budget.quotaWaterlinePercent,
        status: "active"
      }
    },
    tasks
  };
  return request;
}

export async function prepareParallelIssueExecution(input: {
  createGitWorktree?: DesktopHostFilesApi["createGitWorktree"];
  request: CreateIssueManagerIssueFromPlanRequest;
  sourceDirectory?: string | null;
}): Promise<CreateIssueManagerIssueFromPlanRequest> {
  const issueId = input.request.issue.issueId?.trim() ?? "";
  const sourceDirectory = input.sourceDirectory?.trim() ?? "";
  const seenDirectories = new Set<string>();
  const tasks: CreateIssueManagerTaskRequest[] = [];
  for (const task of input.request.tasks) {
    if (!task.agentTargetId?.trim()) {
      tasks.push(task);
      continue;
    }
    const taskId = task.taskId?.trim() ?? "";
    if (!issueId || !taskId || !sourceDirectory || !input.createGitWorktree) {
      throw new Error("agent_plan_parallel_worktree_unavailable");
    }
    // Parallel Issue execution always owns the checkout boundary. A directory
    // suggested by a planning model may be a subdirectory of the source
    // checkout and therefore is not proof of isolation.
    const worktree = await input.createGitWorktree({
      issueId,
      sourceDirectory,
      taskId
    });
    const executionDirectory = worktree?.path.trim() ?? "";
    if (!executionDirectory) {
      throw new Error("agent_plan_parallel_worktree_unavailable");
    }
    const identity = executionDirectory
      .replaceAll("\\", "/")
      .replace(/\/+$/u, "");
    if (!identity || seenDirectories.has(identity)) {
      throw new Error("agent_plan_parallel_worktree_unavailable");
    }
    seenDirectories.add(identity);
    tasks.push({ ...task, executionDirectory });
  }
  return {
    ...input.request,
    issue: {
      ...input.request.issue,
      parallelExecution: true,
      sequentialExecution: false
    },
    tasks
  };
}

function resolvePlanExecutionDirectory(
  sourceDirectory: string | null | undefined,
  assignedDirectory: string | undefined
): string | undefined {
  const assigned = assignedDirectory?.trim();
  if (!assigned) return undefined;
  if (/^(?:\/|\\|[a-z]:[\\/])/iu.test(assigned)) return assigned;

  const source = sourceDirectory?.trim();
  if (!source) {
    throw new Error("issue_plan_execution_directory_source_required");
  }
  const relativeSegments: string[] = [];
  for (const segment of assigned.split(/[\\/]+/u)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (relativeSegments.length === 0) {
        throw new Error("issue_plan_execution_directory_outside_workspace");
      }
      relativeSegments.pop();
      continue;
    }
    relativeSegments.push(segment);
  }
  const separator = source.includes("\\") && !source.includes("/") ? "\\" : "/";
  return `${source.replace(/[\\/]+$/u, "")}${separator}${relativeSegments.join(separator)}`;
}

function resolvePlanText(
  messages: readonly AgentActivityMessage[],
  planTurnId: string
): string | null {
  const candidates = messages
    .filter((message) => message.turnId === planTurnId)
    .sort((left, right) => right.version - left.version);
  const plan = candidates.find(
    (message) => message.payload["messageKind"] === "plan"
  );
  for (const message of plan ? [plan, ...candidates] : candidates) {
    for (const value of [
      message.payload["text"],
      message.payload["content"],
      message.payload["plan"],
      message.payload["body"]
    ]) {
      const text = stringValue(value);
      if (text) return text;
    }
  }
  return null;
}

function createPlanTaskId(): string {
  return createPlanExecutionId("plan-task");
}

function createPlanExecutionId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
