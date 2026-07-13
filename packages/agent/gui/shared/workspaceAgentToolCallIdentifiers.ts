import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes";

export function looksLikeOpaqueToolCallIdentifier(value: string): boolean {
  return /^call[_:-](?:function[_:-])?[a-z0-9][a-z0-9_-]{11,}$/i.test(value);
}

export function isOpaqueWorkspaceAgentToolCallIdentifier(
  value: string | null | undefined,
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }
  const knownCallId = firstPresentString(
    stringRecordValue(item.payload, "callId"),
    stringRecordValue(item.payload, "callID"),
    stringRecordValue(item.payload, "call_id"),
    item.callId
  );
  if (
    knownCallId &&
    normalizeOpaqueToolCallIdentifier(trimmed) ===
      normalizeOpaqueToolCallIdentifier(knownCallId)
  ) {
    return true;
  }
  return looksLikeOpaqueToolCallIdentifier(trimmed);
}

function normalizeOpaqueToolCallIdentifier(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^call:/, "call")
    .replace(/[\s_-]+/gu, "");
}

function firstPresentString(...values: Array<string | undefined>): string {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function stringRecordValue(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
