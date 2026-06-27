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
    left.provider === right.provider &&
    left.userId === right.userId &&
    left.title === right.title &&
    left.imported === right.imported &&
    left.cwd === right.cwd &&
    left.status === right.status &&
    left.lastAgentMessageSummary === right.lastAgentMessageSummary &&
    left.lastAgentMessageAtUnixMs === right.lastAgentMessageAtUnixMs &&
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
  return JSON.stringify(left) === JSON.stringify(right);
}
