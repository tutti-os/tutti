import type {
  AgentActivityMessage,
  AgentActivitySession,
  AgentActivityTurn
} from "@tutti-os/agent-activity-core";
import type {
  TuttiModeActivation,
  WorkspaceAgentSession,
  WorkspaceAgentSessionMessage,
  WorkspaceAgentTurn
} from "@tutti-os/client-tuttid-ts";

export interface AgentActivitySessionMappingOptions {
  currentUserId: string;
}

export function agentActivitySessionFromTuttidSession(
  workspaceId: string,
  session: WorkspaceAgentSession,
  options: AgentActivitySessionMappingOptions
): AgentActivitySession {
  assertTuttidProtocolV2SessionContract(session);
  const createdAtUnixMs = session.createdAtUnixMs;
  const updatedAtUnixMs = session.updatedAtUnixMs;
  return {
    workspaceId,
    agentSessionId: session.id,
    kind: session.kind,
    rootAgentSessionId: session.rootAgentSessionId,
    rootTurnId: session.rootTurnId,
    parentAgentSessionId: session.parentAgentSessionId,
    parentTurnId: session.parentTurnId,
    parentToolCallId: session.parentToolCallId,
    agentTargetId: session.agentTargetId ?? null,
    provider: session.provider,
    providerSessionId: session.providerSessionId ?? session.id,
    userId: options.currentUserId,
    cwd: session.cwd ?? "/",
    railSectionKey: session.railSectionKey,
    title: session.title ?? "",
    activeTurnId: session.activeTurnId,
    activeTurn: session.activeTurn ?? null,
    latestTurn: session.latestTurn ?? null,
    latestTurnInteractions: session.latestTurnInteractions,
    pendingInteractions: session.pendingInteractions,
    settings: cloneSerializable(session.settings),
    permissionConfig: cloneSerializable(session.permissionConfig),
    capabilities: session.capabilities
      ? cloneSerializable(session.capabilities)
      : null,
    usage: session.usage ? cloneSerializable(session.usage) : null,
    goal: session.goal ? cloneSerializable(session.goal) : null,
    tuttiModeActivation: session.tuttiModeActivation
      ? agentActivityTuttiModeActivationFromTuttid(session.tuttiModeActivation)
      : null,
    imported: session.imported ?? false,
    visible: session.visible ?? true,
    resumable: session.resumable ?? false,
    messageVersion: 0,
    lastEventUnixMs: updatedAtUnixMs,
    pinnedAtUnixMs: session.pinnedAtUnixMs ?? null,
    startedAtUnixMs: createdAtUnixMs,
    endedAtUnixMs: session.endedAtUnixMs ?? null,
    createdAtUnixMs,
    updatedAtUnixMs
  };
}

export function agentActivityTurnFromTuttidTurn(
  turn: WorkspaceAgentTurn
): AgentActivityTurn {
  return {
    agentSessionId: turn.agentSessionId,
    completedCommand: turn.completedCommand,
    error: turn.error,
    fileChanges: turn.fileChanges,
    outcome: turn.outcome,
    origin: turn.origin,
    phase: turn.phase,
    ...(turn.sourceGoalOperationId !== undefined
      ? { sourceGoalOperationId: turn.sourceGoalOperationId }
      : {}),
    ...(turn.sourceGoalRevision !== undefined
      ? { sourceGoalRevision: turn.sourceGoalRevision }
      : {}),
    ...(turn.sourceGoalRepairEpoch !== undefined
      ? { sourceGoalRepairEpoch: turn.sourceGoalRepairEpoch }
      : {}),
    settledAtUnixMs: turn.settledAtUnixMs,
    startedAtUnixMs: turn.startedAtUnixMs,
    turnId: turn.turnId,
    updatedAtUnixMs: turn.updatedAtUnixMs
  };
}

export function assertTuttidProtocolV2SessionContract(
  session: WorkspaceAgentSession
): void {
  const value = session as unknown as Record<string, unknown>;
  const missing = [
    "activeTurnId",
    "latestTurnInteractions",
    "pendingInteractions",
    "railSectionKey",
    "tuttiModeActivation"
  ].filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length > 0) {
    throw new Error(
      `Protocol v2 contract error: workspace agent session is missing required field(s): ${missing.join(", ")}`
    );
  }
  if (
    !Array.isArray(value.latestTurnInteractions) ||
    !Array.isArray(value.pendingInteractions)
  ) {
    throw new Error(
      "Protocol v2 contract error: workspace agent interaction collections must be arrays"
    );
  }
  if (
    typeof value.railSectionKey !== "string" ||
    value.railSectionKey.trim().length === 0
  ) {
    throw new Error(
      "Protocol v2 contract error: workspace agent railSectionKey must be a non-empty string"
    );
  }
}

export function agentActivityTuttiModeActivationFromTuttid(
  activation: TuttiModeActivation
) {
  return {
    ...activation,
    currentRevision: { ...activation.currentRevision }
  };
}

export function agentActivityMessageFromTuttidMessage(
  workspaceId: string,
  message: WorkspaceAgentSessionMessage
): AgentActivityMessage {
  return {
    workspaceId,
    agentSessionId: message.agentSessionId,
    completedAtUnixMs: message.completedAtUnixMs ?? undefined,
    kind: message.kind,
    messageId: message.messageId,
    occurredAtUnixMs: normalizedTuttidMessageOccurredAtUnixMs(message),
    payload: recordValue(message.payload),
    role: message.role,
    sequence: message.sequence,
    ...(message.semantics != null
      ? {
          semantics: {
            ...(message.semantics.userVisibleAssistantResponse !== undefined
              ? {
                  userVisibleAssistantResponse:
                    message.semantics.userVisibleAssistantResponse
                }
              : {}),
            ...(message.semantics.turnSettling !== undefined
              ? { turnSettling: message.semantics.turnSettling }
              : {}),
            ...(isNoticeCommand(message.semantics.noticeCommand)
              ? { noticeCommand: message.semantics.noticeCommand }
              : {}),
            ...(isNoticeCommandStatus(message.semantics.noticeCommandStatus)
              ? { noticeCommandStatus: message.semantics.noticeCommandStatus }
              : {})
          }
        }
      : {}),
    startedAtUnixMs: message.startedAtUnixMs ?? undefined,
    createdAtUnixMs: message.createdAtUnixMs ?? undefined,
    status: message.status ?? undefined,
    turnId: normalizedTuttidMessageTurnId(message),
    version: message.version
  };
}

export function normalizedTuttidMessageTurnId(
  message: WorkspaceAgentSessionMessage
): string | null {
  const turnId = message.turnId?.trim() ?? "";
  return turnId || null;
}

export function normalizedTuttidMessageOccurredAtUnixMs(
  message: WorkspaceAgentSessionMessage
): number {
  return (
    positiveNumber(message.occurredAtUnixMs) ??
    positiveNumber(message.startedAtUnixMs) ??
    positiveNumber(message.completedAtUnixMs) ??
    positiveNumber(message.createdAtUnixMs) ??
    positiveNumber(message.updatedAtUnixMs) ??
    positiveNumber(message.version) ??
    1
  );
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function isNoticeCommand(
  value: string | undefined
): value is "compact" | "review" | "undo" | "goal" {
  return (
    value === "compact" ||
    value === "review" ||
    value === "undo" ||
    value === "goal"
  );
}

function isNoticeCommandStatus(
  value: string | undefined
): value is "running" | "completed" | "failed" | "canceled" {
  return (
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "canceled"
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function cloneSerializable<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneSerializable(item)) as T;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneSerializable(item)])
  ) as T;
}
