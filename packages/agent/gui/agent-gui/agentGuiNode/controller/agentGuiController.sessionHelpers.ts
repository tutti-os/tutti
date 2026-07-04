// Agent GUI controller — session control state, message, and timeline helpers.

import type {
  AgentActivityMessageUpdate,
  AgentSessionState
} from "../../../shared/agentSessionTypes";
import { normalizeOptionalWorkspaceAgentStatus } from "../../../shared/workspaceAgentStatusNormalizer";
import type {
  WorkspaceAgentActivityMessage,
  WorkspaceAgentActivityTimelineItem
} from "../../../shared/workspaceAgentActivityTypes";

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
): WorkspaceAgentActivityMessage {
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
    id,
    workspaceId: update.workspaceId?.trim() || "",
    agentSessionId: update.agentSessionId,
    messageId: update.messageId.trim() || `message:${id}`,
    version: id,
    turnId: update.turnId.trim(),
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
      : {})
  };
}

export function mergeAgentSessionControlStateSnapshot(
  current: AgentSessionState | null,
  snapshot: AgentSessionState
): AgentSessionState {
  const incomingUsage = recordValue(snapshot.runtimeContext?.usage);
  if (incomingUsage || !current) {
    return snapshot;
  }
  const previousUsage = recordValue(current.runtimeContext?.usage);
  if (!previousUsage) {
    return snapshot;
  }
  return {
    ...snapshot,
    runtimeContext: {
      ...(snapshot.runtimeContext ?? {}),
      usage: previousUsage
    }
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
