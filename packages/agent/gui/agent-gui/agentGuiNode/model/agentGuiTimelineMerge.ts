import type { WorkspaceAgentActivityTimelineItem } from "../../../shared/workspaceAgentTimelineTypes";
import { objectPayload, stringPayload } from "./agentGuiInteractiveProjection";

export function mergeTimelineItems(
  left: readonly WorkspaceAgentActivityTimelineItem[],
  right: readonly WorkspaceAgentActivityTimelineItem[]
): WorkspaceAgentActivityTimelineItem[] {
  const byKey = new Map<string, WorkspaceAgentActivityTimelineItem>();
  for (const item of [...left, ...right].sort(compareTimelineItemsForMerge)) {
    if (shouldOmitAgentGUITimelineItem(item)) {
      continue;
    }
    const key = timelineItemMergeKey(item);
    const previous = byKey.get(key);
    byKey.set(key, previous ? mergeTimelineItem(previous, item) : item);
  }
  return pruneOptimisticUserPrompts([...byKey.values()]).sort(
    compareTimelineItemsForMerge
  );
}

function shouldOmitAgentGUITimelineItem(
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  const itemType = item.itemType?.trim().toLowerCase() ?? "";
  const payload = objectPayload(item.payload);
  const metadata = objectPayload(payload?.metadata);
  const activityKey =
    stringPayload(payload?.activityKey) || stringPayload(metadata?.activityKey);
  if (activityKey.toLowerCase() === "agent.responding") {
    return true;
  }
  const activityKind =
    stringPayload(payload?.activityKind) ||
    stringPayload(metadata?.activityKind);
  return (
    activityKind.toLowerCase() === "responding" &&
    (itemType === "event" || itemType.startsWith("activity."))
  );
}

function pruneOptimisticUserPrompts(
  items: readonly WorkspaceAgentActivityTimelineItem[]
): WorkspaceAgentActivityTimelineItem[] {
  return items.filter((item) => {
    if (!isOptimisticUserPromptItem(item)) {
      return true;
    }
    const turnId = item.turnId?.trim();
    const body = normalizedTimelineItemBody(item);
    return !items.some((candidate) => {
      return (
        candidate !== item &&
        candidate.role === "user" &&
        !isOptimisticUserPromptItem(candidate) &&
        candidate.turnId?.trim() === turnId &&
        normalizedTimelineItemBody(candidate) === body
      );
    });
  });
}

function isOptimisticUserPromptItem(
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  return item.payload?.__agentGuiOptimisticPrompt === true;
}

function normalizedTimelineItemBody(
  item: WorkspaceAgentActivityTimelineItem
): string {
  const content =
    typeof item.payload?.displayPrompt === "string" &&
    item.payload.displayPrompt.trim()
      ? item.payload.displayPrompt
      : typeof item.payload?.text === "string" && item.payload.text.trim()
        ? item.payload.text
        : typeof item.payload?.content === "string" &&
            item.payload.content.trim()
          ? item.payload.content
          : typeof item.content === "string"
            ? item.content
            : "";
  return content.trim();
}

function timelineItemMergeKey(
  item: WorkspaceAgentActivityTimelineItem
): string {
  const callId = item.callId?.trim();
  if (callId) {
    return `call:${item.turnId?.trim() ?? ""}:${callId}`;
  }
  const eventId = item.eventId?.trim();
  if (eventId) {
    return `event:${eventId}`;
  }
  const seq = item.seq ?? 0;
  if (seq > 0) {
    const turnId = item.turnId?.trim();
    if (turnId) {
      return `seq:${turnId}:${seq}`;
    }
    return `seq:${seq}`;
  }
  return `id:${item.id}`;
}

function mergeTimelineItem(
  previous: WorkspaceAgentActivityTimelineItem,
  next: WorkspaceAgentActivityTimelineItem
): WorkspaceAgentActivityTimelineItem {
  const preserveLatestMessageTimestamp =
    isMessageTimelineItem(previous) || isMessageTimelineItem(next);
  return {
    ...previous,
    ...next,
    id: durableTimelineItemId(previous.id, next.id),
    payload: mergeTimelinePayload(previous.payload, next.payload),
    content: next.content || previous.content,
    status: next.status || previous.status,
    role: next.role || previous.role,
    callId: next.callId || previous.callId,
    callType: next.callType || previous.callType,
    name: next.name || previous.name,
    seq: Math.max(previous.seq ?? 0, next.seq ?? 0),
    occurredAtUnixMs: preserveLatestMessageTimestamp
      ? latestPositiveTimestamp(
          previous.occurredAtUnixMs,
          next.occurredAtUnixMs
        )
      : earliestPositiveTimestamp(
          previous.occurredAtUnixMs,
          next.occurredAtUnixMs
        ),
    createdAtUnixMs: preserveLatestMessageTimestamp
      ? latestPositiveTimestamp(previous.createdAtUnixMs, next.createdAtUnixMs)
      : earliestPositiveTimestamp(
          previous.createdAtUnixMs,
          next.createdAtUnixMs
        )
  };
}

function mergeTimelinePayload(
  previous: WorkspaceAgentActivityTimelineItem["payload"],
  next: WorkspaceAgentActivityTimelineItem["payload"]
): WorkspaceAgentActivityTimelineItem["payload"] {
  const previousRecord = objectPayload(previous);
  const nextRecord = objectPayload(next);
  if (!previousRecord && !nextRecord) {
    return undefined;
  }
  return mergeRecords(previousRecord ?? {}, nextRecord ?? {});
}

function mergeRecords(
  previous: Record<string, unknown>,
  next: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    const previousValue = objectPayload(merged[key]);
    const nextValue = objectPayload(value);
    merged[key] =
      previousValue && nextValue
        ? mergeRecords(previousValue, nextValue)
        : value;
  }
  return merged;
}

function durableTimelineItemId(previousId: number, nextId: number): number {
  if (nextId > 0) {
    return nextId;
  }
  return previousId > 0 ? previousId : nextId;
}

function earliestPositiveTimestamp(
  previous: number | undefined,
  next: number | undefined
): number | undefined {
  const positiveValues = [previous, next].filter(
    (value): value is number => typeof value === "number" && value > 0
  );
  return positiveValues.length > 0 ? Math.min(...positiveValues) : undefined;
}

function latestPositiveTimestamp(
  previous: number | undefined,
  next: number | undefined
): number | undefined {
  const positiveValues = [previous, next].filter(
    (value): value is number => typeof value === "number" && value > 0
  );
  return positiveValues.length > 0 ? Math.max(...positiveValues) : undefined;
}

function isMessageTimelineItem(
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  return item.itemType?.trim().toLowerCase().startsWith("message.") ?? false;
}

export function compareTimelineItemsForMerge(
  left: WorkspaceAgentActivityTimelineItem,
  right: WorkspaceAgentActivityTimelineItem
): number {
  const leftSeq = left.seq ?? 0;
  const rightSeq = right.seq ?? 0;
  return (
    (left.occurredAtUnixMs ?? left.createdAtUnixMs ?? 0) -
      (right.occurredAtUnixMs ?? right.createdAtUnixMs ?? 0) ||
    leftSeq - rightSeq ||
    left.id - right.id
  );
}
