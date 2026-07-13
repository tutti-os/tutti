import type { ToolCallStatusKind } from "./workspaceAgentToolCallDisplay";
import { isWorkspaceAgentSyntheticControlMessage } from "./workspaceAgentSyntheticMessages";
import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes";

export function messageRole(
  item: WorkspaceAgentActivityTimelineItem
): "user" | "agent" | "thinking" | null {
  const explicitRole = item.role?.trim().toLowerCase();
  if (explicitRole === "user") {
    return "user";
  }
  if (explicitRole === "assistant_thinking") {
    return "thinking";
  }
  if (explicitRole === "assistant" || explicitRole === "agent") {
    return "agent";
  }

  const itemType = item.itemType.trim().toLowerCase();
  if (itemType === "message.user") {
    return "user";
  }
  if (itemType === "message.agent" || itemType === "message.assistant") {
    return "agent";
  }
  if (itemType === "message.assistant_thinking") {
    return "thinking";
  }
  return null;
}

export function messageBody(item: WorkspaceAgentActivityTimelineItem): string {
  const payloadContent = item.payload?.content;
  if (typeof payloadContent === "string" && payloadContent.trim()) {
    const content = payloadContent.trim();
    return isWorkspaceAgentSyntheticControlMessage(content) ? "" : content;
  }

  const content = item.content?.trim();
  if (content) {
    return isWorkspaceAgentSyntheticControlMessage(content) ? "" : content;
  }

  const payloadText = item.payload?.text;
  if (typeof payloadText !== "string") {
    return "";
  }
  const text = payloadText.trim();
  return isWorkspaceAgentSyntheticControlMessage(text) ? "" : text;
}

export function thinkingStatusKind(
  item: WorkspaceAgentActivityTimelineItem
): ToolCallStatusKind | null {
  const status = firstPresentString(
    item.status,
    stringRecordValue(item.payload, "status"),
    stringRecordValue(item.payload, "streamState"),
    stringRecordValue(item.payload, "messageStreamState")
  );
  return messageStatusKind(status);
}

export function messageStatusKind(
  status: string | null
): ToolCallStatusKind | null {
  switch (normalizeStatusToken(status)) {
    case "active":
    case "running":
    case "streaming":
    case "working":
    case "inprogress":
    case "in_progress":
      return "working";
    case "completed":
    case "complete":
    case "done":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "canceled":
      return "canceled";
    case "pending":
    case "waiting":
      return "waiting";
    default:
      return null;
  }
}

export function isPlaceholderThinkingBody(body: string): boolean {
  const normalized = body.trim();
  return normalized === "..." || normalized === "…";
}

// Codex review reasoning summaries lead with a bold section title, e.g.
// "**Considering workspace registration order**\n\nI'm looking at...". Hide
// the title in /review process prose; keep the body paragraph.
const reviewProcessSummaryTitlePattern = /^\*\*(.+?)\*\*(?:\r?\n\s*)?/;

export function stripReviewProcessSummaryTitle(body: string): string {
  const match = body.match(reviewProcessSummaryTitlePattern);
  if (!match) {
    return body;
  }
  return body.slice(match[0].length).trimStart();
}

export function normalizedMessageBody(body: string): string {
  return body.trim().replace(/\s+/g, " ");
}

export function isRecentDuplicateUserMessage(
  previous: WorkspaceAgentActivityTimelineItem | undefined,
  current: WorkspaceAgentActivityTimelineItem
): boolean {
  if (!previous) {
    return false;
  }

  const previousTurnId = previous.turnId?.trim();
  const currentTurnId = current.turnId?.trim();
  if (previousTurnId && currentTurnId && previousTurnId === currentTurnId) {
    return true;
  }
  if (previousTurnId && currentTurnId) {
    return false;
  }

  const previousOccurredAt = previous.occurredAtUnixMs ?? 0;
  const currentOccurredAt = current.occurredAtUnixMs ?? 0;
  if (previousOccurredAt > 0 && currentOccurredAt > 0) {
    return Math.abs(currentOccurredAt - previousOccurredAt) <= 60_000;
  }

  const previousSeq = previous.seq ?? 0;
  const currentSeq = current.seq ?? 0;
  if (previousSeq > 0 && currentSeq > 0) {
    return Math.abs(currentSeq - previousSeq) <= 5;
  }

  return false;
}

function stringRecordValue(record: unknown, key: string): string | null {
  if (!record || typeof record !== "object") {
    return null;
  }
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstPresentString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function normalizeStatusToken(value: string | null): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}
