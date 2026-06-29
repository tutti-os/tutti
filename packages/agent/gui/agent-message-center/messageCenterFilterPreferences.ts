import type {
  MessageCenterGroupBy,
  MessageCenterStatusFilter
} from "./workspaceAgentMessageCenterViewModel";

export const messageCenterFiltersStorageKey =
  "tutti.agent-message-center.filters";

export interface MessageCenterFilterPreferences {
  groupBy: MessageCenterGroupBy;
  statusFilters: Set<MessageCenterStatusFilter> | null;
  providerFilters: Set<string> | null;
}

const messageCenterGroupByValues = new Set<MessageCenterGroupBy>([
  "priority",
  "status",
  "agent",
  "time"
]);

const messageCenterStatusFilterValues = new Set<MessageCenterStatusFilter>([
  "waiting",
  "working",
  "completed",
  "failed"
]);

const defaultMessageCenterFilterPreferences: MessageCenterFilterPreferences = {
  groupBy: "priority",
  statusFilters: null,
  providerFilters: null
};

export function readMessageCenterFilterPreferences(): MessageCenterFilterPreferences {
  if (typeof window === "undefined") {
    return defaultMessageCenterFilterPreferences;
  }
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(messageCenterFiltersStorageKey);
  } catch {
    return defaultMessageCenterFilterPreferences;
  }
  if (raw === null) {
    return defaultMessageCenterFilterPreferences;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultMessageCenterFilterPreferences;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return defaultMessageCenterFilterPreferences;
  }
  const record = parsed as Record<string, unknown>;
  return {
    groupBy: resolveStoredGroupBy(record.groupBy),
    statusFilters: resolveStoredStatusFilters(record.statusFilters),
    providerFilters: resolveStoredProviderFilters(record.providerFilters)
  };
}

export function writeMessageCenterFilterPreferences(
  preferences: MessageCenterFilterPreferences
): void {
  if (typeof window === "undefined") {
    return;
  }
  const serialized = JSON.stringify({
    groupBy: preferences.groupBy,
    statusFilters: preferences.statusFilters
      ? [...preferences.statusFilters]
      : null,
    providerFilters: preferences.providerFilters
      ? [...preferences.providerFilters]
      : null
  });
  try {
    window.localStorage.setItem(messageCenterFiltersStorageKey, serialized);
  } catch {
    // Ignore persistence failures (private mode, quota); the in-memory
    // selection still works for this session.
  }
}

function resolveStoredGroupBy(value: unknown): MessageCenterGroupBy {
  return typeof value === "string" &&
    messageCenterGroupByValues.has(value as MessageCenterGroupBy)
    ? (value as MessageCenterGroupBy)
    : "priority";
}

function resolveStoredStatusFilters(
  value: unknown
): Set<MessageCenterStatusFilter> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return new Set(
    value.filter(
      (entry): entry is MessageCenterStatusFilter =>
        typeof entry === "string" &&
        messageCenterStatusFilterValues.has(entry as MessageCenterStatusFilter)
    )
  );
}

function resolveStoredProviderFilters(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return new Set(
    value.filter((entry): entry is string => typeof entry === "string")
  );
}
