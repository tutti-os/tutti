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
    snapshot.sessions.map((session) => {
      const needsAttention = needsAttentionSessionIds.has(
        session.agentSessionId
      );
      const latestTurnStatus = needsAttention
        ? null
        : resolveLatestAgentActivityMessageDisplayStatus(
            resolveSessionMessages(snapshot, session)
          );
      const sessionStatus = normalizeAgentActivityDisplayStatus(
        session.status,
        {
          currentPhase: session.currentPhase,
          needsAttention,
          turnLifecycleOutcome: session.turnLifecycle?.outcome,
          turnLifecyclePhase: session.turnLifecycle?.phase
        }
      );
      return [
        session.agentSessionId,
        sessionStatus === "failed"
          ? shouldLatestTurnStatusOverrideFailedSession(latestTurnStatus)
            ? latestTurnStatus
            : sessionStatus
          : sessionStatus
      ];
    })
  );
}

function shouldLatestTurnStatusOverrideFailedSession(
  status: AgentActivityDisplayStatus | null
): status is AgentActivityDisplayStatus {
  return status !== null && status !== "working" && status !== "idle";
}

export function resolveLatestAgentActivityMessageDisplayStatus(
  messages: readonly AgentActivityMessage[]
): AgentActivityDisplayStatus | null {
  const latestMessage = latestMessageWithTurn(messages);
  const turnId = latestMessage?.turnId?.trim() ?? "";
  if (!latestMessage || !turnId) {
    return null;
  }
  const turnMessages = messages
    .filter((message) => message.turnId?.trim() === turnId)
    .sort(compareMessageOrder);
  const latestStatus = normalizeStatus(turnMessages.at(-1)?.status);
  const latestTerminalStatus = displayStatusFromTerminalStatus(latestStatus);
  if (latestTerminalStatus) {
    return latestTerminalStatus;
  }
  if (isWaitingStatus(latestStatus, "")) {
    return "waiting";
  }
  if (isWorkingStatus(latestStatus)) {
    return "working";
  }
  if (latestMessage.role.trim().toLowerCase() === "user") {
    return "working";
  }
  if (
    turnMessages.some((message) =>
      isWaitingStatus(normalizeStatus(message.status), "")
    )
  ) {
    return "waiting";
  }
  if (
    turnMessages.some((message) =>
      isWorkingStatus(normalizeStatus(message.status))
    )
  ) {
    return "working";
  }
  return null;
}

// SOURCE OF TRUTH: packages/agent/daemon/activity/events/turn_lifecycle_snapshot.go
// (LiveTurnLifecyclePhases / TurnLifecyclePhaseIsLive). Keep both lists
// identical; the Go side owns the vocabulary (ADR 0008).
export const LIVE_TURN_LIFECYCLE_PHASES = [
  "submitted",
  "running",
  "waiting_approval",
  "waiting_input"
] as const;

const LEGACY_LIVE_TURN_LIFECYCLE_PHASES = [
  "working",
  "streaming",
  "waiting",
  "awaiting_approval"
] as const;

export function isLiveTurnLifecyclePhase(
  phase: string | null | undefined
): boolean {
  const normalized = normalizeStatus(phase);
  if (!normalized) {
    return false;
  }
  return (
    (LIVE_TURN_LIFECYCLE_PHASES as readonly string[]).includes(normalized) ||
    (LEGACY_LIVE_TURN_LIFECYCLE_PHASES as readonly string[]).includes(
      normalized
    )
  );
}

// SOURCE OF TRUTH: packages/agent/daemon/activity/events/turn_lifecycle_snapshot.go
// (TurnLifecyclePhaseIsWaiting). Keep both lists identical; the Go side owns
// the vocabulary (ADR 0008).
export const WAITING_TURN_LIFECYCLE_PHASES = [
  "waiting_approval",
  "waiting_input",
  "waiting",
  "awaiting_approval"
] as const;

export function isWaitingTurnLifecyclePhase(
  phase: string | null | undefined
): boolean {
  const normalized = normalizeStatus(phase);
  return (
    normalized !== "" &&
    (WAITING_TURN_LIFECYCLE_PHASES as readonly string[]).includes(normalized)
  );
}

export interface DerivedSubmitAvailability {
  state: "available" | "blocked";
  reason?: "active_turn" | "waiting" | "background_agent";
}

export interface DeriveSubmitAvailabilityInput {
  turnLifecycle?: {
    activeTurnId?: string | null;
    phase?: string | null;
  } | null;
  runtimeContext?: Record<string, unknown> | null;
}

// SOURCE OF TRUTH: packages/agent/daemon/runtime/controller.go
// (submitAvailabilityForAuthoritySession). The wire submitAvailability is a
// value derived by the daemon from the same inputs; consumers making
// decisions must derive locally so a stale wire copy can never contradict
// the turn lifecycle (the record's turnLifecycle and runtimeContext refresh
// together on every state patch, while a dropped patch leaves both stale in
// a mutually consistent way).
//
// Returns null when the record carries no turn lifecycle at all — such
// records (non-migrated providers, fresh sessions) must keep their
// status/currentPhase token fallbacks.
export function deriveSubmitAvailability(
  record: DeriveSubmitAvailabilityInput
): DerivedSubmitAvailability | null {
  const lifecycle = record.turnLifecycle;
  const activeTurnId = lifecycle?.activeTurnId?.trim() ?? "";
  const phase = lifecycle?.phase ?? null;
  if (!lifecycle || (!phase && !activeTurnId)) {
    return null;
  }
  if (isWaitingTurnLifecyclePhase(phase)) {
    return { state: "blocked", reason: "waiting" };
  }
  // Defensive vs Go: a lifecycle with an activeTurnId but no phase counts as
  // a live turn here (the daemon never emits that shape; treating it as busy
  // is the safe direction for queue dispatch).
  if (activeTurnId !== "" || isLiveTurnLifecyclePhase(phase)) {
    return { state: "blocked", reason: "active_turn" };
  }
  if (runtimeContextHasLiveBackgroundAgents(record.runtimeContext)) {
    return { state: "blocked", reason: "background_agent" };
  }
  return { state: "available" };
}

// SOURCE OF TRUTH: packages/agent/daemon/runtime/controller.go
// (sessionHasLiveBackgroundAgents) and claude_sdk_adapter.go
// (claudeSDKBackgroundAgentStatusIsTerminal). count is running-only; an item
// without a status counts as running.
export function runtimeContextHasLiveBackgroundAgents(
  runtimeContext: Record<string, unknown> | null | undefined
): boolean {
  const backgroundAgents = runtimeContext?.backgroundAgents;
  if (!backgroundAgents || typeof backgroundAgents !== "object") {
    return false;
  }
  const record = backgroundAgents as { count?: unknown; items?: unknown };
  if (typeof record.count === "number" && record.count > 0) {
    return true;
  }
  const items = Array.isArray(record.items) ? record.items : [];
  return items.some((item) => {
    // Mirror Go: empty/non-object items are skipped, not treated as agents.
    if (!item || typeof item !== "object" || Object.keys(item).length === 0) {
      return false;
    }
    const status = normalizeStatus(
      (item as { status?: unknown }).status as string
    );
    return !TERMINAL_BACKGROUND_AGENT_STATUSES.has(status || "running");
  });
}

const TERMINAL_BACKGROUND_AGENT_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "stopped"
]);

export function normalizeAgentActivityDisplayStatus(
  status: string | null | undefined,
  options: {
    currentPhase?: string | null;
    needsAttention?: boolean;
    turnLifecycleOutcome?: string | null;
    turnLifecyclePhase?: string | null;
  } = {}
): AgentActivityDisplayStatus {
  const normalizedStatus = normalizeStatus(status);
  const normalizedCurrentPhase = normalizeStatus(options.currentPhase);
  const normalizedTurnLifecycleOutcome = normalizeStatus(
    options.turnLifecycleOutcome
  );
  switch (normalizeStatus(options.turnLifecyclePhase)) {
    case "settled":
      switch (normalizedTurnLifecycleOutcome) {
        case "failed":
        case "error":
          return "failed";
        case "canceled":
        case "cancelled":
        case "interrupted":
          return "canceled";
        case "completed":
        case "done":
        case "success":
        case "succeeded":
          return "completed";
        default:
          break;
      }
      if (
        [normalizedStatus, normalizedCurrentPhase].some(
          (value) => value === "failed" || value === "error"
        )
      ) {
        return "failed";
      }
      if (
        [normalizedStatus, normalizedCurrentPhase].some(
          (value) => value === "canceled" || value === "cancelled"
        )
      ) {
        return "canceled";
      }
      return "completed";
    case "waiting":
    case "waiting_approval":
    case "waiting_input":
    case "awaiting_approval":
      return "waiting";
    case "running":
    case "submitted":
    // Legacy persisted live tokens: a present lifecycle resolves entirely
    // here — status/currentPhase fallbacks apply only when the record has
    // no lifecycle at all (non-migrated providers, ADR 0008).
    case "working":
    case "streaming":
      return "working";
    default:
      break;
  }
  if (options.needsAttention) {
    return "waiting";
  }
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

function resolveSessionMessages(
  snapshot: AgentActivitySnapshot,
  session: AgentActivitySession
): readonly AgentActivityMessage[] {
  return (
    snapshot.sessionMessagesById[session.agentSessionId] ??
    (session.providerSessionId
      ? snapshot.sessionMessagesById[session.providerSessionId]
      : undefined) ??
    []
  );
}

function latestMessageWithTurn(
  messages: readonly AgentActivityMessage[]
): AgentActivityMessage | null {
  return messages.reduce<AgentActivityMessage | null>((latest, message) => {
    if (!message.turnId?.trim()) {
      return latest;
    }
    if (!latest) {
      return message;
    }
    return compareMessageOrder(message, latest) > 0 ? message : latest;
  }, null);
}

function compareMessageOrder(
  left: AgentActivityMessage,
  right: AgentActivityMessage
): number {
  return (
    (left.version ?? 0) - (right.version ?? 0) ||
    (left.occurredAtUnixMs ?? 0) - (right.occurredAtUnixMs ?? 0) ||
    (left.messageId ?? "").localeCompare(right.messageId ?? "")
  );
}

function displayStatusFromTerminalStatus(
  status: string
): AgentActivityDisplayStatus | null {
  switch (status) {
    case "failed":
    case "error":
      return "failed";
    case "canceled":
    case "cancelled":
    case "interrupted":
      return "canceled";
    case "completed":
    case "done":
    case "success":
    case "succeeded":
    case "answered":
    case "rejected":
    case "resolved":
      return "completed";
    default:
      return null;
  }
}

function isWorkingStatus(status: string): boolean {
  return status === "running" || status === "streaming" || status === "working";
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
