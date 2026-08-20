import type {
  AgentActivityEditRetryAvailability,
  AgentActivityDurableMessage,
  AgentActivitySession,
  AgentActivityTuttiModeActivation,
  AgentActivityTurn
} from "@tutti-os/agent-activity-core";
import type {
  TuttiModeActivation,
  WorkspaceAgentEditRetryAvailability,
  WorkspaceAgentSession,
  WorkspaceAgentSessionMessage,
  WorkspaceAgentTurn
} from "@tutti-os/client-tuttid-ts";
import { agentActivityCapabilityReferencesFromTuttid } from "./capabilityReferences.ts";

export interface AgentActivitySessionMappingOptions {
  currentUserId: string;
  lifecycleCapabilitiesProjected?: boolean;
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
    isolation: session.isolation
      ? {
          mode: session.isolation.mode,
          ...(session.isolation.worktreeId
            ? { worktreeId: session.isolation.worktreeId }
            : {}),
          worktreePath: session.isolation.worktreePath,
          branch: session.isolation.branch,
          baseCommit: session.isolation.baseCommit
        }
      : null,
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
    lifecycleCapabilities: cloneSerializable(session.lifecycleCapabilities),
    ...(options.lifecycleCapabilitiesProjected === undefined
      ? {}
      : {
          lifecycleCapabilitiesProjected:
            options.lifecycleCapabilitiesProjected === true
        }),
    forkedFrom: session.forkedFrom
      ? cloneSerializable(session.forkedFrom)
      : null,
    usage: session.usage ? cloneSerializable(session.usage) : null,
    goal: session.goal ? cloneSerializable(session.goal) : null,
    goalSyncState: session.goalSyncState
      ? {
          revision: session.goalSyncState.revision,
          syncStatus: session.goalSyncState.syncStatus,
          pendingOperationId:
            session.goalSyncState.pendingOperationId?.trim() || null,
          executionPending: session.goalSyncState.executionPending === true
        }
      : null,
    tuttiModeActivation: session.tuttiModeActivation
      ? agentActivityTuttiModeActivationFromTuttid(session.tuttiModeActivation)
      : null,
    imported: session.imported ?? false,
    visible: session.visible ?? true,
    resumable: session.resumable ?? false,
    messageVersion: session.messageVersion,
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
  const capabilityRefs = agentActivityCapabilityReferencesFromTuttid(
    turn.capabilityRefs
  );
  return {
    agentSessionId: turn.agentSessionId,
    ...(capabilityRefs.length > 0 ? { capabilityRefs } : {}),
    providerForkBindingAvailable: turn.providerForkBindingAvailable,
    providerForkBindingState: turn.providerForkBindingState,
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

export function agentActivityEditRetryAvailabilityFromTuttid(
  availability: WorkspaceAgentEditRetryAvailability
): AgentActivityEditRetryAvailability {
  return {
    supported: availability.supported,
    eligible: availability.eligible,
    ...(availability.turnId ? { turnId: availability.turnId } : {}),
    historyRevision: availability.historyRevision,
    recoveryState: availability.recoveryState,
    ...(availability.operationId
      ? { operationId: availability.operationId }
      : {}),
    availableActions: [...availability.availableActions],
    ...(availability.reasonCode ? { reasonCode: availability.reasonCode } : {})
  };
}

export function assertTuttidProtocolV2SessionContract(
  session: WorkspaceAgentSession
): void {
  const value = session as unknown as Record<string, unknown>;
  const missing = [
    "activeTurnId",
    "latestTurnInteractions",
    "lifecycleCapabilities",
    "forkedFrom",
    "goalSyncState",
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
  if (!isTuttidGoalSyncState(value.goalSyncState)) {
    throw new Error(
      "Protocol v2 contract error: workspace agent goalSyncState is invalid"
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
  if (
    typeof value.messageVersion !== "number" ||
    !Number.isSafeInteger(value.messageVersion) ||
    value.messageVersion < 0
  ) {
    throw new Error(
      "Protocol v2 contract error: workspace agent messageVersion must be a non-negative safe integer"
    );
  }
}

function isTuttidGoalSyncState(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(state.revision) &&
    (state.revision as number) >= 0 &&
    typeof state.syncStatus === "string" &&
    TUTTID_GOAL_SYNC_STATUSES.has(state.syncStatus) &&
    (state.pendingOperationId === null ||
      typeof state.pendingOperationId === "string") &&
    typeof state.executionPending === "boolean"
  );
}

const TUTTID_GOAL_SYNC_STATUSES = new Set([
  "pending",
  "applying",
  "synced",
  "diverged",
  "unknown",
  "failed"
]);

export function agentActivityTuttiModeActivationFromTuttid(
  activation: TuttiModeActivation
): AgentActivityTuttiModeActivation {
  const effect = tuttiModePreference(
    activation.currentRevision.effect,
    activation.currentRevision.orchestrationIntensity
  );
  const speed = tuttiModePreference(activation.currentRevision.speed, 50);
  return {
    ...activation,
    currentRevision: {
      ...activation.currentRevision,
      effect,
      speed,
      orchestrationIntensity: effect
    }
  };
}

function tuttiModePreference(
  value: number | null | undefined,
  fallback: number
): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < 0 || candidate > 100) {
    throw new Error(
      "Protocol contract error: Tutti mode preference must be an integer between 0 and 100"
    );
  }
  return candidate;
}

export function agentActivityMessageFromTuttidMessage(
  workspaceId: string,
  message: WorkspaceAgentSessionMessage
): AgentActivityDurableMessage {
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
