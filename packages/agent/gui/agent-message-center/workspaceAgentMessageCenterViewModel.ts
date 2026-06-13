import type { TranslateFn } from "../i18n/index";
import { workspaceAgentProviderLabel } from "../shared/workspaceAgentProviderLabel";
import {
  isWaitingMessageCenterItem,
  type WorkspaceAgentMessageCenterIdentity,
  type WorkspaceAgentMessageCenterItem,
  type WorkspaceAgentMessageCenterModel
} from "./workspaceAgentMessageCenterModel";

export type MessageCenterGroupBy = "priority" | "status" | "agent" | "time";
export type MessageCenterStatusFilter =
  | "waiting"
  | "working"
  | "completed"
  | "failed";

export type MessageCenterTranslate = TranslateFn;

export interface MessageCenterStatusOption {
  count: number;
  label: string;
  value: MessageCenterStatusFilter;
}

export interface MessageCenterProviderOption {
  count: number;
  label: string;
  value: string;
}

export interface MessageCenterGroup {
  id: string;
  identity?: WorkspaceAgentMessageCenterIdentity | null;
  label: string;
  items: WorkspaceAgentMessageCenterItem[];
  provider?: string;
  userId?: string | null;
}

export interface MessageCenterAgentUserStack {
  id: string;
  provider: string;
  userId: string | null;
  items: WorkspaceAgentMessageCenterItem[];
}

export function partitionMessageCenterItemsByAgentUser(
  items: readonly WorkspaceAgentMessageCenterItem[]
): MessageCenterAgentUserStack[] {
  const stacks = new Map<string, MessageCenterAgentUserStack>();
  for (const item of items) {
    const stackId = messageCenterAgentUserStackId(item);
    const stack = stacks.get(stackId);
    if (stack) {
      stack.items.push(item);
    } else {
      stacks.set(stackId, {
        id: stackId,
        provider: item.provider,
        userId: item.userId,
        items: [item]
      });
    }
  }
  return [...stacks.values()];
}

export function messageCenterAgentUserStackId(
  item: Pick<WorkspaceAgentMessageCenterItem, "provider" | "userId">
): string {
  const provider = item.provider.trim().toLowerCase() || "unknown-agent";
  const userId = item.userId?.trim() || "unknown-user";
  return `agent-user:${provider}:${userId}`;
}

export function buildMessageCenterStatusOptions(
  counts: WorkspaceAgentMessageCenterModel["counts"],
  t: MessageCenterTranslate
): MessageCenterStatusOption[] {
  return [
    {
      count: counts.waiting,
      label: t("agentHost.workspaceAgentMessageCenterFilterWaiting"),
      value: "waiting"
    },
    {
      count: counts.failed,
      label: t("agentHost.workspaceAgentMessageCenterFilterFailed"),
      value: "failed"
    },
    {
      count: counts.working,
      label: t("agentHost.workspaceAgentMessageCenterFilterWorking"),
      value: "working"
    },
    {
      count: counts.completed,
      label: t("agentHost.workspaceAgentMessageCenterFilterCompleted"),
      value: "completed"
    }
  ];
}

export function buildMessageCenterProviderOptions(
  items: readonly WorkspaceAgentMessageCenterItem[]
): MessageCenterProviderOption[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({
      count,
      label: workspaceAgentProviderLabel(value),
      value
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function itemMatchesViewFilters({
  item,
  providerFilters,
  statusFilters
}: {
  item: WorkspaceAgentMessageCenterItem;
  providerFilters: Set<string> | null;
  statusFilters: Set<MessageCenterStatusFilter> | null;
}): boolean {
  if (
    statusFilters &&
    !statusFilters.has(messageCenterStatusFilterValue(item))
  ) {
    return false;
  }
  if (providerFilters && !providerFilters.has(item.provider)) {
    return false;
  }
  return true;
}

export function messageCenterStatusFilterValue(
  item: WorkspaceAgentMessageCenterItem
): MessageCenterStatusFilter {
  if (isWaitingMessageCenterItem(item)) {
    return "waiting";
  }
  if (item.status === "failed") {
    return "failed";
  }
  if (item.status === "working") {
    return "working";
  }
  return "completed";
}

export function groupMessageCenterItems(
  items: readonly WorkspaceAgentMessageCenterItem[],
  groupBy: MessageCenterGroupBy,
  t: MessageCenterTranslate
): MessageCenterGroup[] {
  switch (groupBy) {
    case "status":
      return groupByFixedDefinitions(items, [
        {
          id: "waiting",
          label: t("agentHost.workspaceAgentMessageCenterFilterWaiting"),
          match: (item) => messageCenterStatusFilterValue(item) === "waiting"
        },
        {
          id: "failed",
          label: t("agentHost.workspaceAgentMessageCenterFilterFailed"),
          match: (item) => messageCenterStatusFilterValue(item) === "failed"
        },
        {
          id: "working",
          label: t("agentHost.workspaceAgentMessageCenterFilterWorking"),
          match: (item) => messageCenterStatusFilterValue(item) === "working"
        },
        {
          id: "completed",
          label: t("agentHost.workspaceAgentMessageCenterFilterCompleted"),
          match: (item) => messageCenterStatusFilterValue(item) === "completed"
        }
      ]);
    case "agent":
      return groupByDynamicKey(items, (item) => ({
        id: messageCenterAgentUserStackId(item),
        identity: item.identity,
        label: messageCenterAgentUserGroupLabel(item),
        provider: item.provider,
        userId: item.userId
      }));
    case "time":
      return groupByFixedDefinitions(items, [
        {
          id: "today",
          label: t("agentHost.workspaceAgentMessageCenterGroupToday"),
          match: (item) => messageCenterTimeGroup(item) === "today"
        },
        {
          id: "yesterday",
          label: t("agentHost.workspaceAgentMessageCenterGroupYesterday"),
          match: (item) => messageCenterTimeGroup(item) === "yesterday"
        },
        {
          id: "previous-seven-days",
          label: t(
            "agentHost.workspaceAgentMessageCenterGroupPreviousSevenDays"
          ),
          match: (item) =>
            messageCenterTimeGroup(item) === "previous-seven-days"
        },
        {
          id: "older",
          label: t("agentHost.workspaceAgentMessageCenterGroupOlder"),
          match: (item) => messageCenterTimeGroup(item) === "older"
        }
      ]);
    case "priority":
    default: {
      const nowUnixMs = Date.now();
      return groupByFixedDefinitions(items, [
        {
          id: "needs-attention",
          label: t("agentHost.workspaceAgentMessageCenterGroupNeedsAttention"),
          match: (item) =>
            messageCenterStatusFilterValue(item) === "waiting" ||
            messageCenterStatusFilterValue(item) === "failed"
        },
        {
          id: "working",
          label: t("agentHost.workspaceAgentMessageCenterFilterWorking"),
          match: (item) => messageCenterStatusFilterValue(item) === "working"
        },
        {
          id: "recently-completed",
          label: t(
            "agentHost.workspaceAgentMessageCenterGroupRecentlyCompleted"
          ),
          match: (item) => isRecentlyCompletedMessageCenterItem(item, nowUnixMs)
        },
        {
          id: "completed",
          label: t("agentHost.workspaceAgentMessageCenterFilterCompleted"),
          match: (item) =>
            messageCenterStatusFilterValue(item) === "completed" &&
            !isRecentlyCompletedMessageCenterItem(item, nowUnixMs)
        }
      ]);
    }
  }
}

function messageCenterAgentUserGroupLabel(
  item: WorkspaceAgentMessageCenterItem
): string {
  if (item.identity) {
    return `${item.identity.userName} & ${item.identity.agentName}`;
  }
  return workspaceAgentProviderLabel(item.provider);
}

const RECENTLY_COMPLETED_WINDOW_MS = 10 * 60 * 1000;

export function isRecentlyCompletedMessageCenterItem(
  item: WorkspaceAgentMessageCenterItem,
  nowUnixMs: number
): boolean {
  if (messageCenterStatusFilterValue(item) !== "completed") {
    return false;
  }
  const completedAtUnixMs =
    item.sortTimeUnixMs || item.lastAgentMessageAtUnixMs || 0;
  if (completedAtUnixMs <= 0) {
    return false;
  }
  return completedAtUnixMs >= nowUnixMs - RECENTLY_COMPLETED_WINDOW_MS;
}

export function messageCenterGroupLabel(
  groupBy: MessageCenterGroupBy,
  t: MessageCenterTranslate
): string {
  switch (groupBy) {
    case "status":
      return t("agentHost.workspaceAgentMessageCenterGroupStatus");
    case "agent":
      return t("agentHost.workspaceAgentMessageCenterGroupAgent");
    case "time":
      return t("agentHost.workspaceAgentMessageCenterGroupTime");
    case "priority":
    default:
      return t("agentHost.workspaceAgentMessageCenterGroupPriority");
  }
}

export function statusFilterSummary(
  statusFilters: Set<MessageCenterStatusFilter> | null,
  statusOptions: readonly MessageCenterStatusOption[]
): string {
  if (statusFilters === null || statusFilters.size === statusOptions.length) {
    return statusOptions.map((option) => option.label).join(", ");
  }
  return statusOptions
    .filter((option) => statusFilters.has(option.value))
    .map((option) => option.label)
    .join(", ");
}

function groupByFixedDefinitions(
  items: readonly WorkspaceAgentMessageCenterItem[],
  definitions: Array<{
    id: string;
    label: string;
    match: (item: WorkspaceAgentMessageCenterItem) => boolean;
  }>
): MessageCenterGroup[] {
  return definitions
    .map((definition) => ({
      id: definition.id,
      label: definition.label,
      items: items.filter(definition.match)
    }))
    .filter((group) => group.items.length > 0);
}

function groupByDynamicKey(
  items: readonly WorkspaceAgentMessageCenterItem[],
  keyForItem: (item: WorkspaceAgentMessageCenterItem) => {
    id: string;
    identity?: WorkspaceAgentMessageCenterIdentity | null;
    label: string;
    provider?: string;
    userId?: string | null;
  }
): MessageCenterGroup[] {
  const groups = new Map<string, MessageCenterGroup>();
  for (const item of items) {
    const key = keyForItem(item);
    const group = groups.get(key.id);
    if (group) {
      group.items.push(item);
      if (!group.identity && key.identity) {
        group.identity = key.identity;
        group.label = key.label;
      }
    } else {
      groups.set(key.id, { ...key, items: [item] });
    }
  }
  return [...groups.values()];
}

function messageCenterTimeGroup(
  item: WorkspaceAgentMessageCenterItem
): "older" | "previous-seven-days" | "today" | "yesterday" {
  const timestamp = item.sortTimeUnixMs || item.lastAgentMessageAtUnixMs || 0;
  if (timestamp <= 0) {
    return "older";
  }
  const ageMs = Date.now() - timestamp;
  const dayMs = 24 * 60 * 60 * 1000;
  if (ageMs < dayMs) {
    return "today";
  }
  if (ageMs < dayMs * 2) {
    return "yesterday";
  }
  if (ageMs < dayMs * 7) {
    return "previous-seven-days";
  }
  return "older";
}
