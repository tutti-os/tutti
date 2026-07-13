import { canonicalInteractionKey } from "./sessionEntityKeys.ts";
import type {
  PlanDecisionRecord,
  PlanDecisionState
} from "./planDecision.types.ts";
import type {
  EngineCommand,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];

export function createInitialPlanDecisionState(): PlanDecisionState {
  return { byId: {}, dismissedByTurnKey: {} };
}

export function planDecisionReducer(
  state: PlanDecisionState,
  intent: EngineIntent,
  context: { feedbackAccepted: boolean; planTurnValid: boolean } = {
    feedbackAccepted: false,
    planTurnValid: false
  }
): EngineReducerResult<PlanDecisionState> {
  if (intent.type === "session/removed") {
    const sessionId = intent.agentSessionId.trim();
    const byId = Object.fromEntries(
      Object.entries(state.byId).filter(
        ([, record]) => record.agentSessionId !== sessionId
      )
    );
    const dismissedByTurnKey = Object.fromEntries(
      Object.entries(state.dismissedByTurnKey).filter(
        ([key]) => !key.startsWith(`${sessionId}\0`)
      )
    );
    return Object.keys(byId).length === Object.keys(state.byId).length &&
      Object.keys(dismissedByTurnKey).length ===
        Object.keys(state.dismissedByTurnKey).length
      ? unchanged(state)
      : { commands: NO_COMMANDS, state: { byId, dismissedByTurnKey } };
  }
  if (
    intent.type === "plan/feedbackRequested" ||
    intent.type === "plan/skipped"
  ) {
    if (
      !context.planTurnValid ||
      (intent.type === "plan/feedbackRequested" && !context.feedbackAccepted)
    )
      return unchanged(state);
    const key = dismissedTurnKey(intent.agentSessionId, intent.turnId);
    return {
      commands: NO_COMMANDS,
      state: {
        ...state,
        dismissedByTurnKey: { ...state.dismissedByTurnKey, [key]: true }
      }
    };
  }
  if (intent.type === "plan/decisionRequested") {
    const record = recordFromIntent(intent);
    const key = decisionKey(
      record.agentSessionId,
      record.turnId,
      record.requestId
    );
    const existing = state.byId[key];
    if (
      !record.commandId ||
      !record.idempotencyKey ||
      !context.planTurnValid ||
      (existing &&
        (!intent.retry ||
          existing.idempotencyKey !== record.idempotencyKey ||
          (existing.status !== "failed" && existing.status !== "unknown")))
    ) {
      return unchanged(state);
    }
    return {
      commands: [
        { ...intent, type: "plan/submitDecision", correlationId: key }
      ],
      state: {
        ...state,
        byId: { ...state.byId, [key]: record }
      }
    };
  }
  if (
    intent.type === "engine/commandResult" &&
    intent.commandType === "plan/submitDecision"
  ) {
    const key = intent.correlationId?.trim() ?? "";
    const record = state.byId[key];
    if (!record || record.commandId !== intent.commandId)
      return unchanged(state);
    if (intent.outcome === "succeeded") {
      const validation = validateOperation(intent.value, record);
      if (validation.status === "completed") {
        const removed = remove(state, key);
        return {
          commands: NO_COMMANDS,
          state: {
            ...removed,
            dismissedByTurnKey: {
              ...removed.dismissedByTurnKey,
              [dismissedTurnKey(record.agentSessionId, record.turnId)]: true
            }
          }
        };
      }
      if (validation.status === "failed") {
        return replace(state, key, {
          ...record,
          errorCode: "operation_failed",
          errorMessage: null,
          operationId: validation.operationId,
          status: "failed"
        });
      }
      if (validation.status === "invalid") {
        return replace(state, key, {
          ...record,
          errorCode: "invalid_command_result",
          errorMessage: null,
          status: "unknown"
        });
      }
      return replace(state, key, {
        ...record,
        errorCode: null,
        errorMessage: null,
        operationId: validation.operationId,
        status: "unknown"
      });
    }
    return replace(state, key, {
      ...record,
      errorCode: intent.errorCode ?? null,
      errorMessage:
        intent.outcome === "failed"
          ? intent.errorMessage?.trim() || null
          : null,
      status: intent.outcome === "failed" ? "failed" : "unknown"
    });
  }
  if (intent.type === "message/snapshotReceived") {
    let next = state;
    for (const message of intent.messages) {
      if (message.payload.kind !== "agent_system_notice") continue;
      const noticeKind = message.payload.noticeKind;
      if (
        noticeKind !== "plan_implementation_completed" &&
        noticeKind !== "plan_implementation_pending_confirmation"
      )
        continue;
      const operationId = text(message.payload.operationId);
      const planTurnId = text(message.payload.planTurnId);
      if (!operationId || !planTurnId) continue;
      for (const [key, record] of Object.entries(next.byId)) {
        if (
          record.status !== "unknown" ||
          record.workspaceId !==
            (message.workspaceId?.trim() || intent.workspaceId?.trim()) ||
          record.agentSessionId !== message.agentSessionId.trim() ||
          record.turnId !== planTurnId ||
          record.operationId !== operationId
        )
          continue;
        if (noticeKind === "plan_implementation_completed") {
          const removed = remove(next, key);
          next = {
            ...removed,
            dismissedByTurnKey: {
              ...removed.dismissedByTurnKey,
              [dismissedTurnKey(record.agentSessionId, record.turnId)]: true
            }
          };
        }
      }
    }
    return next === state
      ? unchanged(state)
      : { commands: NO_COMMANDS, state: next };
  }
  if (
    intent.type === "interaction/upserted" &&
    intent.interaction.status !== "pending"
  ) {
    return removeMatching(
      state,
      intent.interaction.agentSessionId,
      intent.interaction.requestId
    );
  }
  return unchanged(state);
}

function recordFromIntent(
  intent: Extract<EngineIntent, { type: "plan/decisionRequested" }>
): PlanDecisionRecord {
  return {
    action: intent.action,
    agentSessionId: intent.agentSessionId.trim(),
    commandId: intent.commandId.trim(),
    errorCode: null,
    errorMessage: null,
    idempotencyKey: intent.idempotencyKey.trim(),
    operationId: null,
    payload: intent.payload ? { ...intent.payload } : null,
    promptKind: intent.promptKind,
    requestId: intent.requestId.trim(),
    status: "requested",
    turnId: intent.turnId.trim(),
    workspaceId: intent.workspaceId.trim()
  };
}

function validateOperation(
  value: unknown,
  record: PlanDecisionRecord
): {
  operationId: string | null;
  status: "completed" | "pending" | "failed" | "invalid";
} {
  if (!value || typeof value !== "object")
    return { operationId: null, status: "invalid" };
  const operation = (value as { operation?: Record<string, unknown> })
    .operation;
  if (
    !operation ||
    operation.workspaceId !== record.workspaceId ||
    operation.agentSessionId !== record.agentSessionId ||
    operation.turnId !== record.turnId ||
    operation.requestId !== record.requestId ||
    operation.idempotencyKey !== record.idempotencyKey
  )
    return { operationId: null, status: "invalid" };
  const operationId = text(operation.operationId);
  if (!operationId) return { operationId: null, status: "invalid" };
  const status =
    operation.status === "completed"
      ? "completed"
      : operation.status === "failed"
        ? "failed"
        : operation.status === "prepared" || operation.status === "leased"
          ? "pending"
          : "invalid";
  return { operationId, status };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function removeMatching(
  state: PlanDecisionState,
  sessionId: string,
  requestId: string
) {
  let next = state;
  for (const [key, record] of Object.entries(state.byId)) {
    if (record.agentSessionId === sessionId && record.requestId === requestId) {
      next = remove(next, key);
    }
  }
  return next === state
    ? unchanged(state)
    : { commands: NO_COMMANDS, state: next };
}

function replace(
  state: PlanDecisionState,
  key: string,
  record: PlanDecisionRecord
) {
  return {
    commands: NO_COMMANDS,
    state: { ...state, byId: { ...state.byId, [key]: record } }
  };
}

function remove(state: PlanDecisionState, key: string): PlanDecisionState {
  const byId = { ...state.byId };
  delete byId[key];
  return { ...state, byId };
}

function unchanged(
  state: PlanDecisionState
): EngineReducerResult<PlanDecisionState> {
  return { commands: NO_COMMANDS, state };
}

function decisionKey(
  sessionId: string,
  turnId: string,
  requestId: string
): string {
  return canonicalInteractionKey(sessionId, turnId, requestId);
}

function dismissedTurnKey(sessionId: string, turnId: string): string {
  return `${sessionId.trim()}\0${turnId.trim()}`;
}
