import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import type { BuildWorkspaceAgentSessionDetailInput } from "../../workspaceAgentSessionDetailViewModel";
import { buildCanonicalWorkspaceAgentDetailView } from "../../workspaceAgentTimelineCanonical";
import { resolveWorkspaceAgentNoticeCommandSemantics } from "../../workspaceAgentSystemNoticeSemantics";
import type { WorkspaceAgentActivityTimelineItem } from "../../workspaceAgentTimelineTypes";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import {
  projectAgentConversationVM,
  type AgentConversationProjectionOptions
} from "./agentConversationProjection";

export interface ProjectWorkspaceAgentMessagesInput extends Omit<
  BuildWorkspaceAgentSessionDetailInput,
  "timelineItems"
> {
  messages: AgentActivityMessage[];
}

export function projectWorkspaceAgentMessagesToConversationVM(
  input: ProjectWorkspaceAgentMessagesInput,
  options: AgentConversationProjectionOptions = {}
): AgentConversationVM {
  const timelineItems = projectWorkspaceAgentMessagesToTimelineItems(
    input.messages
  );
  const detail = buildCanonicalWorkspaceAgentDetailView({
    activity: input.activity,
    session: input.session,
    workspaceRoot: input.workspaceRoot,
    timelineItems
  });
  return projectAgentConversationVM(detail, options);
}

const tuttiPlanIssueDispatchTriggerPrefix = "issue:tutti-mode-plan-";

/**
 * Per-run delegate cards for tutti-plan Issue dispatch stay out of the
 * timeline: the embedded plan-issue panel carries that state per task, and a
 * duplicate card per run reads as unrelated noise. Collaboration records from
 * any other source keep their cards.
 */
function isTuttiPlanIssueDispatchCollaboration(
  message: AgentActivityMessage
): boolean {
  if (message.kind?.trim() !== "collaboration") {
    return false;
  }
  const triggerReason = message.payload?.triggerReason;
  return (
    typeof triggerReason === "string" &&
    triggerReason.startsWith(tuttiPlanIssueDispatchTriggerPrefix)
  );
}

export function projectWorkspaceAgentMessagesToTimelineItems(
  messages: readonly AgentActivityMessage[]
): WorkspaceAgentActivityTimelineItem[] {
  const sortedMessages = latestMessageSnapshots(messages)
    .filter((message) => !isTuttiPlanIssueDispatchCollaboration(message))
    .sort(compareMessagesByDisplayOrder);
  const mergedToolPayloadByKey = new Map<string, Record<string, unknown>>();

  return sortedMessages.map((message, index) => {
    const kind = normalizeToken(message.kind);
    const role = normalizeToken(message.role);
    const payload = normalizedPayload(message.payload);
    const goalControlAudit = isGoalControlAudit(message);
    const id = normalizedMessageId(message.version, index);
    const seq = index + 1;
    const eventId = goalControlAudit
      ? firstNonEmptyString(
          stringValue(payload.messageId),
          message.messageId,
          `message:${id}`
        )
      : message.messageId.trim() || `message:${id}`;
    const turnId = message.turnId?.trim() || undefined;
    const occurredAtUnixMs = messageDisplayOrderTime(message);

    if (goalControlAudit) {
      return messageTimelineItem({
        message,
        id,
        seq,
        eventId,
        actorType: "user",
        itemType: "goal.control",
        role: "user",
        content: messageText(message),
        occurredAtUnixMs
      });
    }

    if (kind === "tool_call") {
      const callId = firstNonEmptyString(
        messagePayloadString(message, "callId"),
        message.messageId
      );
      const title = messagePayloadString(message, "title");
      const toolKey = callId || eventId;
      const payloadToolName = displayToolNameCandidate(
        stringValue(payload.toolName),
        callId
      );
      const titleToolName = displayToolNameCandidate(title, callId);
      const toolName = firstNonEmptyString(payloadToolName, titleToolName);
      const toolPayload = sanitizedToolPayload(payload, callId);
      const mergedPayload = mergePayload(mergedToolPayloadByKey.get(toolKey), {
        ...toolPayload,
        ...(toolName ? { toolName } : {}),
        ...(message.status?.trim() ? { status: message.status.trim() } : {})
      });
      mergedToolPayloadByKey.set(toolKey, mergedPayload);
      const callType =
        firstNonEmptyString(stringValue(mergedPayload.callType)) || "tool";
      const workspaceId = workspaceIdFromMessage(message);
      return {
        id,
        ...workspaceTimelineFields(workspaceId),
        agentSessionId: message.agentSessionId,
        seq,
        ...(turnId ? { turnId } : {}),
        eventId,
        actorType: "agent",
        actorId: message.agentSessionId,
        itemType: toolCallItemType(message.status ?? undefined),
        role: "assistant",
        callType,
        callId,
        name: firstNonEmptyString(toolName, titleToolName) || "Tool",
        ...(message.status !== undefined ? { status: message.status } : {}),
        payload: mergedPayload,
        ...(occurredAtUnixMs !== undefined ? { occurredAtUnixMs } : {}),
        ...(message.startedAtUnixMs !== undefined
          ? { createdAtUnixMs: message.startedAtUnixMs }
          : {}),
        ...(message.startedAtUnixMs !== undefined
          ? { startedAtUnixMs: message.startedAtUnixMs }
          : {}),
        ...(message.completedAtUnixMs !== undefined
          ? { completedAtUnixMs: message.completedAtUnixMs }
          : {})
      };
    }

    if (kind === "collaboration") {
      // Collaboration runs (model consult/fork/delegate/handoff) are durable
      // assistant-side messages the daemon updates in place by messageId
      // ("collab:<runId>"). Keep the full payload so the canonical detail view
      // can project the typed collaboration card even while resultText is
      // still empty (running consult).
      return messageTimelineItem({
        message,
        id,
        seq,
        eventId,
        turnId,
        actorType: "agent",
        itemType: "collaboration",
        role: "assistant",
        content: messagePayloadString(message, "resultText") ?? "",
        occurredAtUnixMs
      });
    }

    if (kind === "reasoning") {
      return messageTimelineItem({
        message,
        id,
        seq,
        eventId,
        turnId,
        actorType: "agent",
        itemType: "message.assistant_thinking",
        role: "assistant_thinking",
        content: messageText(message),
        occurredAtUnixMs
      });
    }

    if ((kind === "text" || kind === "session_audit") && role === "user") {
      return messageTimelineItem({
        message,
        id,
        seq,
        eventId,
        turnId,
        actorType: "user",
        itemType: "message.user",
        role: "user",
        content: messageText(message),
        occurredAtUnixMs
      });
    }

    if (kind === "text" && (role === "assistant" || role === "agent")) {
      const projectedMessage = normalizeLegacyCompactNotice(message, payload);
      return messageTimelineItem({
        message: projectedMessage,
        id,
        seq,
        eventId,
        turnId,
        actorType: "agent",
        itemType: "message.assistant",
        role: "assistant",
        content: messageText(projectedMessage),
        occurredAtUnixMs
      });
    }

    const statusTurnId =
      turnId ?? `session-status:${kind === "error" ? "error" : "notice"}`;
    const statusMessage: AgentActivityMessage = {
      ...message,
      payload:
        kind === "error"
          ? {
              ...payload,
              detail: messageText(message),
              kind: "agent_visible_error"
            }
          : {
              ...payload,
              detail: messageText(message),
              kind: "agent_system_notice",
              noticeKind: kind,
              severity: "info"
            }
    };
    return messageTimelineItem({
      message: statusMessage,
      id,
      seq,
      eventId,
      turnId: statusTurnId,
      actorType: role === "user" ? "user" : "agent",
      itemType: role === "user" ? "message.user" : "message.assistant",
      role: role === "user" ? "user" : "assistant",
      content: statusMessageText(statusMessage),
      occurredAtUnixMs
    });
  });
}

function isGoalControlAudit(message: AgentActivityMessage): boolean {
  return (
    normalizeToken(message.kind) === "session_audit" &&
    normalizedPayload(message.payload).goalControl === true
  );
}

function normalizeLegacyCompactNotice(
  message: AgentActivityMessage,
  payload: Record<string, unknown>
): AgentActivityMessage {
  const commandSemantics = resolveWorkspaceAgentNoticeCommandSemantics({
    eventId: message.messageId,
    messageSemantics: message.semantics,
    payload,
    status: message.status
  });
  if (commandSemantics?.command !== "compact") {
    return message;
  }
  const commandStatus = commandSemantics.commandStatus;
  const title =
    stringValue(payload.title) ||
    (commandStatus === "completed"
      ? "Context compacted."
      : commandStatus === "running"
        ? "Compacting context."
        : "Context compaction interrupted.");
  const originalText = messageText(message);
  const detail =
    stringValue(payload.detail) ||
    (commandStatus === "failed" || commandStatus === "canceled"
      ? originalText.replace(/^Compacting failed:\s*/iu, "").trim()
      : "");
  return {
    ...message,
    semantics: {
      ...message.semantics,
      noticeCommand: "compact",
      noticeCommandStatus: commandStatus
    },
    payload: {
      ...payload,
      kind: "agent_system_notice",
      noticeKind: stringValue(payload.noticeKind) || "system_notice",
      noticeCommand: "compact",
      noticeCommandStatus: commandStatus,
      title,
      text: title,
      content: title,
      ...(detail ? { detail } : {})
    }
  };
}

function latestMessageSnapshots(
  messages: readonly AgentActivityMessage[]
): AgentActivityMessage[] {
  const latestByKey = new Map<string, AgentActivityMessage>();
  const unkeyedMessages: AgentActivityMessage[] = [];
  for (const message of messages) {
    const key = messageSnapshotKey(message);
    if (!key) {
      unkeyedMessages.push(message);
      continue;
    }
    const previous = latestByKey.get(key);
    if (!previous || (message.version ?? 0) >= (previous.version ?? 0)) {
      latestByKey.set(key, mergeMessageSnapshot(previous, message));
    } else {
      latestByKey.set(key, mergeMessageSnapshot(message, previous));
    }
  }

  return [...unkeyedMessages, ...latestByKey.values()];
}

function mergeMessageSnapshot(
  previous: AgentActivityMessage | undefined,
  next: AgentActivityMessage
): AgentActivityMessage {
  const semantics =
    previous?.semantics || next.semantics
      ? { ...previous?.semantics, ...next.semantics }
      : undefined;
  return {
    ...previous,
    ...next,
    sequence: next.sequence ?? previous?.sequence,
    createdAtUnixMs: next.createdAtUnixMs ?? previous?.createdAtUnixMs,
    ...(semantics ? { semantics } : {}),
    payload: {
      ...(previous?.payload ?? {}),
      ...(next.payload ?? {})
    }
  };
}

function messageSnapshotKey(message: AgentActivityMessage): string | null {
  const messageId = message.messageId.trim();
  if (!messageId) {
    return null;
  }

  return `${message.agentSessionId.trim()}\u0000${messageId}`;
}

function messageTimelineItem({
  message,
  id,
  seq,
  eventId,
  turnId,
  actorType,
  itemType,
  role,
  content,
  occurredAtUnixMs
}: {
  message: AgentActivityMessage;
  id: number;
  seq: number;
  eventId: string;
  turnId?: string;
  actorType: string;
  itemType: string;
  role: string;
  content: string;
  occurredAtUnixMs?: number;
}): WorkspaceAgentActivityTimelineItem {
  const workspaceId = workspaceIdFromMessage(message);
  return {
    id,
    ...workspaceTimelineFields(workspaceId),
    agentSessionId: message.agentSessionId,
    seq,
    ...(turnId ? { turnId } : {}),
    eventId,
    actorType,
    actorId: actorType === "user" ? "user" : message.agentSessionId,
    itemType,
    role,
    status: message.status,
    ...(message.semantics ? { messageSemantics: message.semantics } : {}),
    content,
    payload: normalizedPayload(message.payload),
    ...(occurredAtUnixMs !== undefined ? { occurredAtUnixMs } : {}),
    ...(message.startedAtUnixMs !== undefined
      ? { createdAtUnixMs: message.startedAtUnixMs }
      : {}),
    ...(message.startedAtUnixMs !== undefined
      ? { startedAtUnixMs: message.startedAtUnixMs }
      : {}),
    ...(message.completedAtUnixMs !== undefined
      ? { completedAtUnixMs: message.completedAtUnixMs }
      : {})
  };
}

function workspaceIdFromMessage(message: AgentActivityMessage): string {
  return message.workspaceId?.trim() || "";
}

function workspaceTimelineFields(
  workspaceId: string
): Pick<WorkspaceAgentActivityTimelineItem, "workspaceId"> {
  return {
    workspaceId
  };
}

function compareMessagesByDisplayOrder(
  left: AgentActivityMessage,
  right: AgentActivityMessage
): number {
  // Durable sequence is assigned once when the message is first stored and is
  // not changed by later streaming snapshots. Timestamps are compatibility
  // fallbacks for messages produced by older runtimes.
  const leftSequence = normalizedPositiveNumber(left.sequence);
  const rightSequence = normalizedPositiveNumber(right.sequence);
  if (leftSequence > 0 && rightSequence > 0 && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  const leftTime = messageDisplayOrderTime(left);
  const rightTime = messageDisplayOrderTime(right);
  if (leftTime > 0 && rightTime > 0 && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  const leftVersion = normalizedPositiveNumber(left.version);
  const rightVersion = normalizedPositiveNumber(right.version);
  if (leftVersion > 0 && rightVersion > 0 && leftVersion !== rightVersion) {
    return leftVersion - rightVersion;
  }
  // Sorting opaque message ids would manufacture chronology and can move a
  // user prompt behind the assistant output it initiated.
  return 0;
}

function normalizedMessageId(id: number | undefined, index: number): number {
  const normalizedId = typeof id === "number" ? id : 0;
  return Number.isFinite(normalizedId) && normalizedId > 0
    ? normalizedId
    : index + 1;
}

function normalizedPositiveNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function messageDisplayOrderTime(message: AgentActivityMessage): number {
  return (
    normalizedPositiveNumber(message.startedAtUnixMs) ||
    normalizedPositiveNumber(message.createdAtUnixMs) ||
    normalizedPositiveNumber(message.occurredAtUnixMs) ||
    normalizedPositiveNumber(message.completedAtUnixMs)
  );
}

function toolCallItemType(status: string | undefined): string {
  switch (normalizeToken(status)) {
    case "running":
    case "working":
    case "active":
      return "call.started";
    case "completed":
    case "complete":
    case "done":
    case "success":
    case "succeeded":
      return "call.completed";
    case "failed":
    case "error":
      return "call.failed";
    case "canceled":
      return "call.canceled";
    default:
      return "call";
  }
}

function messageText(message: AgentActivityMessage): string {
  const payload = normalizedPayload(message.payload);
  const title = messagePayloadString(message, "title");
  return firstNonEmptyString(
    stringValue(payload.displayPrompt),
    stringValue(payload.text),
    stringValue(payload.content),
    stringValue(payload.message),
    stringValue(payload.body),
    title
  );
}

function statusMessageText(message: AgentActivityMessage): string {
  const title = messagePayloadString(message, "title") ?? "";
  const text = messageText(message);
  if (title && text && title !== text) {
    return `${title}\n\n${text}`;
  }
  return title || text;
}

function messagePayloadString(
  message: AgentActivityMessage,
  key: string
): string | undefined {
  return stringValue(normalizedPayload(message.payload)[key]);
}

function mergePayload(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>
): Record<string, unknown> {
  if (!previous) {
    return next;
  }
  const merged = { ...previous, ...next };
  for (const key of [
    "input",
    "output",
    "error",
    "metadata",
    "toolState",
    "tool_state"
  ]) {
    if (isRecord(previous[key]) || isRecord(next[key])) {
      merged[key] = {
        ...(isRecord(previous[key]) ? previous[key] : {}),
        ...(isRecord(next[key]) ? next[key] : {})
      };
    }
  }
  return merged;
}

function normalizedPayload(
  payload: Record<string, unknown> | undefined
): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
}

function sanitizedToolPayload(
  payload: Record<string, unknown>,
  callId: string | undefined
): Record<string, unknown> {
  if (!isOpaqueCallIdentifierString(stringValue(payload.toolName), callId)) {
    return payload;
  }
  const { toolName: _toolName, ...rest } = payload;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function firstNonEmptyString(
  ...values: Array<string | undefined | null>
): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function displayToolNameCandidate(
  value: string | undefined,
  callId: string | undefined
): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || isOpaqueCallIdentifierString(trimmed, callId)) {
    return "";
  }
  return trimmed;
}

function isOpaqueCallIdentifierString(
  value: string,
  callId: string | undefined
): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (callId?.trim() && trimmed === callId.trim()) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("call_")) {
    return isOpaqueIdentifierTail(trimmed.slice("call_".length));
  }
  if (lower.startsWith("ws_")) {
    return isOpaqueIdentifierTail(trimmed.slice("ws_".length));
  }
  return false;
}

function isOpaqueIdentifierTail(value: string): boolean {
  return value.length >= 12 && /^[a-z0-9]+$/i.test(value);
}

function normalizeToken(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}
