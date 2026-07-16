import type {
  WorkspaceAgentMessageCenterCounts,
  WorkspaceAgentMessageCenterIdentity,
  WorkspaceAgentMessageCenterItem,
  WorkspaceAgentMessageCenterModel,
  WorkspaceAgentMessageCenterTurnOutcome
} from "./workspaceAgentMessageCenterModel";
import type { WorkspaceAgentMessageCenterDigest } from "./workspaceAgentMessageCenterDigest";

type WorkspaceAgentMessageCenterPrompt =
  WorkspaceAgentMessageCenterItem["pendingPrompt"];
type WorkspaceAgentMessageCenterAskUserQuestions = Extract<
  NonNullable<WorkspaceAgentMessageCenterPrompt>,
  { kind: "ask-user" }
>["questions"];

export function stabilizeWorkspaceAgentMessageCenterModel(
  previous: WorkspaceAgentMessageCenterModel | null,
  next: WorkspaceAgentMessageCenterModel
): WorkspaceAgentMessageCenterModel {
  if (!previous) {
    return next;
  }

  const previousItemsById = new Map(
    previous.items.map((item) => [item.id, item])
  );
  let itemsChanged = previous.items.length !== next.items.length;
  const items = next.items.map((nextItem, index) => {
    const previousItem = previousItemsById.get(nextItem.id);
    const stableItem =
      previousItem && messageCenterItemsEqual(previousItem, nextItem)
        ? previousItem
        : nextItem;
    if (stableItem !== previous.items[index]) {
      itemsChanged = true;
    }
    return stableItem;
  });
  const stableItems = itemsChanged ? items : previous.items;
  const stableCounts = messageCenterCountsEqual(previous.counts, next.counts)
    ? previous.counts
    : next.counts;

  if (
    previous.waitingCount === next.waitingCount &&
    stableItems === previous.items &&
    stableCounts === previous.counts
  ) {
    return previous;
  }

  return {
    ...next,
    counts: stableCounts,
    items: stableItems
  };
}

function messageCenterItemsEqual(
  left: WorkspaceAgentMessageCenterItem,
  right: WorkspaceAgentMessageCenterItem
): boolean {
  return (
    left.id === right.id &&
    left.agentSessionId === right.agentSessionId &&
    left.agentTargetId === right.agentTargetId &&
    left.agentName === right.agentName &&
    left.agentAvatarUrl === right.agentAvatarUrl &&
    left.provider === right.provider &&
    left.userId === right.userId &&
    left.title === right.title &&
    left.imported === right.imported &&
    left.cwd === right.cwd &&
    left.status === right.status &&
    left.lastAgentMessageSummary === right.lastAgentMessageSummary &&
    left.lastAgentMessageAtUnixMs === right.lastAgentMessageAtUnixMs &&
    messageCenterInteractionTargetEqual(
      left.pendingInteractionTarget,
      right.pendingInteractionTarget
    ) &&
    left.needsAttentionKind === right.needsAttentionKind &&
    left.needsAttentionSummary === right.needsAttentionSummary &&
    left.sortTimeUnixMs === right.sortTimeUnixMs &&
    messageCenterIdentityEqual(left.identity, right.identity) &&
    messageCenterDigestEqual(left.digest, right.digest) &&
    messageCenterPromptEqual(left.pendingPrompt, right.pendingPrompt) &&
    messageCenterTurnOutcomeEqual(
      left.latestTurnOutcome ?? null,
      right.latestTurnOutcome ?? null
    )
  );
}

function messageCenterInteractionTargetEqual(
  left: WorkspaceAgentMessageCenterItem["pendingInteractionTarget"],
  right: WorkspaceAgentMessageCenterItem["pendingInteractionTarget"]
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.agentSessionId === right.agentSessionId &&
      left.turnId === right.turnId &&
      left.requestId === right.requestId)
  );
}

function messageCenterCountsEqual(
  left: WorkspaceAgentMessageCenterCounts,
  right: WorkspaceAgentMessageCenterCounts
): boolean {
  return (
    left.all === right.all &&
    left.working === right.working &&
    left.waiting === right.waiting &&
    left.completed === right.completed &&
    left.failed === right.failed
  );
}

function messageCenterIdentityEqual(
  left: WorkspaceAgentMessageCenterIdentity | null,
  right: WorkspaceAgentMessageCenterIdentity | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.userName === right.userName &&
    left.userAvatarUrl === right.userAvatarUrl &&
    left.agentName === right.agentName &&
    left.agentAvatarUrl === right.agentAvatarUrl
  );
}

function messageCenterDigestEqual(
  left: WorkspaceAgentMessageCenterDigest,
  right: WorkspaceAgentMessageCenterDigest
): boolean {
  return (
    left.primary.kind === right.primary.kind &&
    left.primary.summary === right.primary.summary &&
    left.primary.occurredAtUnixMs === right.primary.occurredAtUnixMs
  );
}

function messageCenterTurnOutcomeEqual(
  left: WorkspaceAgentMessageCenterTurnOutcome | null,
  right: WorkspaceAgentMessageCenterTurnOutcome | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.notificationKey === right.notificationKey &&
    left.status === right.status &&
    left.turnId === right.turnId
  );
}

function messageCenterPromptEqual(
  left: WorkspaceAgentMessageCenterPrompt,
  right: WorkspaceAgentMessageCenterPrompt
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "approval":
      return (
        right.kind === "approval" &&
        left.id === right.id &&
        left.turnId === right.turnId &&
        left.requestId === right.requestId &&
        left.callId === right.callId &&
        left.title === right.title &&
        left.toolName === right.toolName &&
        left.status === right.status &&
        left.occurredAtUnixMs === right.occurredAtUnixMs &&
        messageCenterJsonValueEqual(left.input, right.input) &&
        messageCenterJsonValueEqual(
          left.output ?? null,
          right.output ?? null
        ) &&
        messageCenterApprovalOptionsEqual(left.options, right.options)
      );
    case "ask-user":
      return (
        right.kind === "ask-user" &&
        left.requestId === right.requestId &&
        left.title === right.title &&
        messageCenterAskUserQuestionsEqual(left.questions, right.questions)
      );
    case "exit-plan":
      return (
        right.kind === "exit-plan" &&
        left.requestId === right.requestId &&
        left.title === right.title &&
        left.keepPlanningOptionId === right.keepPlanningOptionId &&
        messageCenterApprovalOptionsEqual(left.options, right.options)
      );
    case "plan-implementation":
      return (
        right.kind === "plan-implementation" &&
        left.requestId === right.requestId &&
        left.title === right.title
      );
  }
}

function messageCenterApprovalOptionsEqual(
  left: readonly {
    description?: string;
    id: string;
    kind: string;
    label: string;
  }[],
  right: readonly {
    description?: string;
    id: string;
    kind: string;
    label: string;
  }[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((option, index) => {
    const rightOption = right[index];
    return (
      rightOption &&
      option.id === rightOption.id &&
      option.label === rightOption.label &&
      option.kind === rightOption.kind &&
      option.description === rightOption.description
    );
  });
}

function messageCenterAskUserQuestionsEqual(
  left: WorkspaceAgentMessageCenterAskUserQuestions,
  right: WorkspaceAgentMessageCenterAskUserQuestions
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((question, index) => {
    const rightQuestion = right[index];
    return (
      rightQuestion &&
      question.id === rightQuestion.id &&
      question.header === rightQuestion.header &&
      question.question === rightQuestion.question &&
      question.multiSelect === rightQuestion.multiSelect &&
      messageCenterAnswerEqual(
        question.answer ?? null,
        rightQuestion.answer ?? null
      ) &&
      question.options.length === rightQuestion.options.length &&
      question.options.every((option, optionIndex) => {
        const rightOption = rightQuestion.options[optionIndex];
        return (
          rightOption &&
          option.label === rightOption.label &&
          option.description === rightOption.description
        );
      })
    );
  });
}

function messageCenterAnswerEqual(
  left: string | string[] | null,
  right: string | string[] | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function messageCenterJsonValueEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }
    return (
      left.length === right.length &&
      left.every((value, index) =>
        messageCenterJsonValueEqual(value, right[index])
      )
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) {
    return false;
  }
  return leftKeys.every((key) =>
    messageCenterJsonValueEqual(leftRecord[key], rightRecord[key])
  );
}
