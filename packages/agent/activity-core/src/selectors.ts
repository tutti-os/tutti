import type {
  AgentActivityDisplayStatus,
  AgentActivityMessage,
  AgentActivityNeedsAttentionItem,
  AgentActivityNeedsAttentionKind,
  AgentActivitySession,
  AgentActivitySnapshot
} from "./types.ts";

const terminalMessageStatuses = new Set([
  "completed",
  "canceled",
  "failed",
  "rejected",
  "answered",
  "resolved"
]);

export function selectNeedsAttentionCount(
  snapshot: AgentActivitySnapshot
): number {
  return selectNeedsAttentionItems(snapshot).length;
}

export function selectSessionDisplayStatuses(
  snapshot: AgentActivitySnapshot
): Map<string, AgentActivityDisplayStatus> {
  const needsAttentionSessionIds = new Set(
    selectNeedsAttentionItems(snapshot).map((item) => item.agentSessionId)
  );
  return new Map(
    snapshot.sessions.map((session) => [
      session.agentSessionId,
      normalizeAgentActivityDisplayStatus(session.status, {
        currentPhase: session.currentPhase,
        needsAttention: needsAttentionSessionIds.has(session.agentSessionId)
      })
    ])
  );
}

export function normalizeAgentActivityDisplayStatus(
  status: string | null | undefined,
  options: {
    currentPhase?: string | null;
    needsAttention?: boolean;
  } = {}
): AgentActivityDisplayStatus {
  if (options.needsAttention) {
    return "waiting";
  }
  const normalizedStatus = normalizeStatus(status);
  const normalizedCurrentPhase = normalizeStatus(options.currentPhase);
  switch (normalizedStatus) {
    case "completed":
    case "done":
    case "success":
    case "succeeded":
      return "completed";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "error":
    case "failed":
      return "failed";
    default:
      break;
  }
  switch (normalizedCurrentPhase) {
    case "completed":
    case "done":
    case "success":
    case "succeeded":
      return "completed";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "error":
    case "failed":
      return "failed";
    case "awaiting_approval":
    case "waiting":
    case "waiting_approval":
    case "waiting_input":
      return "waiting";
    case "running":
    case "streaming":
    case "working":
      return "working";
    default:
      break;
  }
  switch (normalizedStatus) {
    case "running":
    case "streaming":
    case "working":
      return "working";
    case "awaiting_approval":
    case "waiting":
    case "waiting_approval":
    case "waiting_input":
      return "waiting";
    case "idle":
    case "ready":
    default:
      return "idle";
  }
}

export function selectNeedsAttentionItems(
  snapshot: AgentActivitySnapshot
): AgentActivityNeedsAttentionItem[] {
  const sessionsById = new Map(
    snapshot.sessions.map((session) => [session.agentSessionId, session])
  );
  const items: AgentActivityNeedsAttentionItem[] = [];

  for (const [agentSessionId, messages] of Object.entries(
    snapshot.sessionMessagesById
  )) {
    const session = sessionsById.get(agentSessionId);
    for (const message of messages) {
      const kind = needsAttentionKindForMessage(message);
      if (!kind) {
        continue;
      }
      items.push(
        needsAttentionItemFromMessage(snapshot, message, kind, session)
      );
    }
  }

  return items.sort(
    (left, right) =>
      right.occurredAtUnixMs - left.occurredAtUnixMs ||
      left.id.localeCompare(right.id)
  );
}

function needsAttentionKindForMessage(
  message: AgentActivityMessage
): AgentActivityNeedsAttentionKind | null {
  if (isTerminalMessageStatus(message.status)) {
    return null;
  }

  const kind = normalizeKind(message.kind);
  const payloadType = normalizeMetadataValue(message.payload.type);
  const action = normalizeMetadataValue(message.payload.action);
  const requestType = normalizeMetadataValue(message.payload.requestType);
  const callType = normalizeMetadataValue(message.payload.callType);
  const toolName = normalizeMetadataValue(message.payload.toolName);
  const name = normalizeMetadataValue(message.payload.name);
  const status = normalizeStatus(message.status);
  const payloadStatus = normalizeMetadataValue(message.payload.status);

  if (
    includesAny(
      [
        kind,
        payloadType,
        requestType,
        callType,
        toolName,
        name,
        status,
        payloadStatus
      ].join(" "),
      ["permission", "approval"]
    )
  ) {
    return "permission";
  }

  if (
    includesAny(
      [
        kind,
        payloadType,
        action,
        callType,
        toolName,
        name,
        status,
        payloadStatus
      ].join(" "),
      ["ask_user", "ask-user", "askuserquestion", "question"]
    )
  ) {
    return "question";
  }

  if (
    includesAny([kind, payloadType, action, toolName, name].join(" "), [
      "constraint"
    ])
  ) {
    return "constraint";
  }

  if (
    isWaitingStatus(status, payloadStatus) &&
    (message.role === "assistant" || message.role === "system")
  ) {
    return "other";
  }

  return null;
}

function needsAttentionItemFromMessage(
  snapshot: AgentActivitySnapshot,
  message: AgentActivityMessage,
  kind: AgentActivityNeedsAttentionKind,
  session: AgentActivitySession | undefined
): AgentActivityNeedsAttentionItem {
  return {
    id: `${message.agentSessionId}:${message.messageId}`,
    workspaceId: message.workspaceId || snapshot.workspaceId,
    agentSessionId: message.agentSessionId,
    provider: session?.provider ?? "",
    title: session?.title ?? "",
    cwd: session?.cwd ?? "",
    kind,
    summary: messageSummary(message),
    occurredAtUnixMs:
      message.occurredAtUnixMs ??
      message.startedAtUnixMs ??
      message.completedAtUnixMs ??
      session?.updatedAtUnixMs ??
      session?.lastEventUnixMs ??
      0
  };
}

function messageSummary(message: AgentActivityMessage): string {
  return (
    stringValue(message.payload.displayPrompt) ||
    stringValue(message.payload.summary) ||
    stringValue(message.payload.title) ||
    stringValue(message.payload.text) ||
    stringValue(message.payload.content) ||
    message.kind
  );
}

function isTerminalMessageStatus(status: string | null | undefined): boolean {
  return terminalMessageStatuses.has(normalizeStatus(status));
}

function normalizeStatus(status: string | null | undefined): string {
  return status?.trim().toLowerCase() ?? "";
}

function isWaitingStatus(...values: readonly string[]): boolean {
  return values.some((value) => {
    const normalized = value.trim().toLowerCase();
    return normalized === "waiting" || normalized.startsWith("waiting_");
  });
}

function normalizeKind(kind: string): string {
  return kind.trim().toLowerCase();
}

function normalizeMetadataValue(value: unknown): string {
  return stringValue(value).toLowerCase();
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
