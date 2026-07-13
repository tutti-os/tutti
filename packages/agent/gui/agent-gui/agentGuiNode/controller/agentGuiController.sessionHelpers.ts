// Agent GUI controller — session control state, message, and timeline helpers.

import type { AgentActivityMessageUpdate } from "../../../shared/agentSessionTypes";
import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import { normalizeOptionalWorkspaceAgentStatus } from "../../../shared/workspaceAgentStatusNormalizer";
import type { WorkspaceAgentActivityTimelineItem } from "../../../shared/workspaceAgentTimelineTypes";

export function normalizeTimelineStatus(
  value: string | null | undefined
): "working" | "waiting" | null {
  const normalized = normalizeOptionalWorkspaceAgentStatus({
    status: value ?? undefined
  });
  if (normalized?.kind === "working" || normalized?.kind === "waiting") {
    return normalized.kind;
  }
  switch (value?.trim().toLowerCase()) {
    case "active":
    case "in_progress":
      return "working";
    case "pending":
      return "waiting";
    default:
      return null;
  }
}

export function messageFromMessageUpdate(
  update: AgentActivityMessageUpdate
): AgentActivityMessage {
  const payload = update.payload ?? {};
  const normalizedKind = update.kind.trim().toLowerCase();
  const normalizedRole = update.role.trim().toLowerCase();
  const id =
    normalizedPositiveNumber(update.seq) ??
    normalizedPositiveNumber(update.occurredAtUnixMs) ??
    0;
  const isToolCall = normalizedKind === "tool_call";
  const kind = isToolCall
    ? "tool_call"
    : normalizedKind === "reasoning"
      ? "reasoning"
      : "text";
  const role = normalizedRole === "user" ? "user" : "assistant";
  return {
    workspaceId: update.workspaceId?.trim() || "",
    agentSessionId: update.agentSessionId,
    messageId: update.messageId.trim() || `message:${id}`,
    version: id,
    turnId: update.turnId?.trim() || null,
    role,
    kind,
    status: update.status,
    payload: {
      ...payload,
      ...(isToolCall && update.callId?.trim()
        ? { callId: update.callId.trim() }
        : {}),
      ...(isToolCall && update.title?.trim()
        ? { title: update.title.trim() }
        : {})
    },
    occurredAtUnixMs: update.occurredAtUnixMs,
    ...(update.startedAtUnixMs !== undefined
      ? { startedAtUnixMs: update.startedAtUnixMs }
      : {}),
    ...(update.completedAtUnixMs !== undefined
      ? { completedAtUnixMs: update.completedAtUnixMs }
      : {})
  };
}

export function normalizedPositiveNumber(
  value: number | undefined
): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

export function timelineItemTime(
  item: WorkspaceAgentActivityTimelineItem
): number {
  return item.occurredAtUnixMs ?? item.createdAtUnixMs ?? 0;
}
