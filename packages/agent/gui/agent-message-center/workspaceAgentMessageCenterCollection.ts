import type {
  WorkspaceAgentMessageCenterCounts,
  WorkspaceAgentMessageCenterItem,
  WorkspaceAgentMessageCenterModel
} from "./workspaceAgentMessageCenterModel";
import type { AgentActivityNeedsAttentionItem } from "@tutti-os/agent-activity-core";

const EMPTY_COUNTS: WorkspaceAgentMessageCenterCounts = {
  all: 0,
  working: 0,
  waiting: 0,
  completed: 0,
  failed: 0
};

export function buildWorkspaceAgentMessageCenterModelFromItems(
  sourceItems: readonly WorkspaceAgentMessageCenterItem[],
  itemCutoffUnixMs?: number | null
): WorkspaceAgentMessageCenterModel {
  const items = sourceItems
    .filter((item) => isWithinItemCutoff(item, itemCutoffUnixMs))
    .sort(compareItems);
  return {
    waitingCount: items.filter(isWaitingMessageCenterItem).length,
    items,
    counts: countItems(items)
  };
}

export function latestNeedsAttentionBySessionId(
  items: readonly AgentActivityNeedsAttentionItem[]
): Map<string, AgentActivityNeedsAttentionItem> {
  const bySessionId = new Map<string, AgentActivityNeedsAttentionItem>();
  for (const item of items) {
    const previous = bySessionId.get(item.agentSessionId);
    if (!previous || item.occurredAtUnixMs > previous.occurredAtUnixMs) {
      bySessionId.set(item.agentSessionId, item);
    }
  }
  return bySessionId;
}

export function isWaitingMessageCenterItem(
  item: WorkspaceAgentMessageCenterItem
): boolean {
  return item.pendingPrompt !== null || item.needsAttentionKind !== null;
}

export function isInteractiveMessageCenterItem(
  item: WorkspaceAgentMessageCenterItem
): boolean {
  return item.pendingPrompt !== null;
}

export function selectMessageCenterAttentionDeckItems(
  items: readonly WorkspaceAgentMessageCenterItem[]
): WorkspaceAgentMessageCenterItem[] {
  return items.filter(isInteractiveMessageCenterItem);
}

export function isCompletedMessageCenterItem(
  item: WorkspaceAgentMessageCenterItem
): boolean {
  return (
    item.status === "completed" ||
    item.status === "canceled" ||
    item.status === "idle"
  );
}

function isWithinItemCutoff(
  item: WorkspaceAgentMessageCenterItem,
  cutoffUnixMs: number | null | undefined
): boolean {
  if (!Number.isFinite(cutoffUnixMs)) return true;
  if (isWaitingMessageCenterItem(item)) return true;
  const timestamp = item.sortTimeUnixMs || item.lastAgentMessageAtUnixMs || 0;
  return timestamp >= Number(cutoffUnixMs);
}

function countItems(
  items: readonly WorkspaceAgentMessageCenterItem[]
): WorkspaceAgentMessageCenterCounts {
  return items.reduce<WorkspaceAgentMessageCenterCounts>(
    (counts, item) => {
      counts.all += 1;
      if (isWaitingMessageCenterItem(item)) {
        counts.waiting += 1;
      } else if (isCompletedMessageCenterItem(item)) {
        counts.completed += 1;
      } else if (item.status === "working") {
        counts.working += 1;
      } else if (item.status === "failed") {
        counts.failed += 1;
      }
      return counts;
    },
    { ...EMPTY_COUNTS }
  );
}

function compareItems(
  left: WorkspaceAgentMessageCenterItem,
  right: WorkspaceAgentMessageCenterItem
): number {
  const leftWaiting = isWaitingMessageCenterItem(left);
  const rightWaiting = isWaitingMessageCenterItem(right);
  if (leftWaiting !== rightWaiting) return leftWaiting ? -1 : 1;
  return (
    right.sortTimeUnixMs - left.sortTimeUnixMs ||
    left.agentSessionId.localeCompare(right.agentSessionId)
  );
}
