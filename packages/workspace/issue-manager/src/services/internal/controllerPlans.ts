import type {
  IssueManagerIssueDetail,
  IssueManagerAgentTargetOption,
  IssueManagerTaskDetail
} from "../../contracts/index.ts";
import type { IssueDraft, TaskDraft } from "./controllerTypes.ts";

export type IssueManagerSavePlan<TResult> =
  | {
      kind: "blocked";
      notificationKey: "messages.titleRequired" | "messages.topicListEmpty";
    }
  | ({ kind: "ready" } & TResult);

export function createIssueManagerRunTaskPlan(input: {
  agentTargetOptions?: readonly IssueManagerAgentTargetOption[];
  agentTargetIdOverride?: string;
  issueDetail: IssueManagerIssueDetail | null;
  selectedAgentTargetId: string;
  taskDetail: IssueManagerTaskDetail | null;
}):
  | {
      kind: "ready";
      agentTargetId: string;
      provider: string;
      shouldUpdateSelectedAgentTargetId: boolean;
    }
  | { kind: "skip" } {
  if (!input.issueDetail) {
    return { kind: "skip" };
  }

  const agentTargetId =
    input.agentTargetIdOverride?.trim() || input.selectedAgentTargetId.trim();
  if (!agentTargetId) {
    return { kind: "skip" };
  }
  const option = input.agentTargetOptions?.find(
    (candidate) => candidate.agentTargetId?.trim() === agentTargetId
  );
  const provider =
    option?.provider.trim() || legacyProviderFromTargetId(agentTargetId);

  return {
    agentTargetId,
    kind: "ready",
    provider,
    shouldUpdateSelectedAgentTargetId:
      agentTargetId !== input.selectedAgentTargetId
  };
}

function legacyProviderFromTargetId(agentTargetId: string): string {
  const targetId = agentTargetId.trim();
  if (targetId.startsWith("local:")) {
    return targetId.slice("local:".length);
  }
  return targetId.includes(":") ? "" : targetId;
}

export function createIssueManagerSaveIssuePlan(input: {
  activeTopicId: string | null;
  issueDraft: IssueDraft;
}): IssueManagerSavePlan<{ activeTopicId: string }> {
  if (!input.activeTopicId) {
    return {
      kind: "blocked",
      notificationKey: "messages.topicListEmpty"
    };
  }

  const title = input.issueDraft.title.trim();
  if (!title) {
    return {
      kind: "blocked",
      notificationKey: "messages.titleRequired"
    };
  }

  return { kind: "ready", activeTopicId: input.activeTopicId };
}

export function createIssueManagerSaveTaskPlan(input: {
  selectedIssueId: string | null;
  taskDraft: TaskDraft;
}): IssueManagerSavePlan<{ selectedIssueId: string }> | { kind: "skip" } {
  if (!input.selectedIssueId) {
    return { kind: "skip" };
  }

  const title = input.taskDraft.title.trim();
  if (!title) {
    return {
      kind: "blocked",
      notificationKey: "messages.titleRequired"
    };
  }

  return {
    kind: "ready",
    selectedIssueId: input.selectedIssueId
  };
}

export function shouldIssueManagerNotifyRunFailure(status: string): boolean {
  return status !== "completed";
}
