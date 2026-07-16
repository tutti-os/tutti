import type { AgentActivitySession } from "../types.ts";
import type {
  EngineCommand,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import type { CanonicalAgentSession } from "./sessionLifecycle.types.ts";
import type {
  TuttiModeActivationState,
  TuttiModeActivationUpdateRecord
} from "./tuttiModeActivation.types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];
const UPDATE_TIMEOUT_MS = 15_000;

interface TuttiModeActivationReducerContext {
  sessionsById: Readonly<Record<string, CanonicalAgentSession>>;
}

export function createInitialTuttiModeActivationState(): TuttiModeActivationState {
  return {
    activationsBySessionId: {},
    draftsByKey: {},
    pendingCreatesBySessionId: {},
    updatesBySessionId: {}
  };
}

export function tuttiModeActivationReducer(
  state: TuttiModeActivationState,
  intent: EngineIntent,
  context: TuttiModeActivationReducerContext
): EngineReducerResult<TuttiModeActivationState> {
  switch (intent.type) {
    case "tuttiMode/draftSet":
      return setDraft(state, intent);
    case "tuttiMode/updateRequested":
      return requestUpdate(state, intent, context.sessionsById);
    case "activation/requested":
      return trackPendingCreate(state, intent);
    case "engine/commandResult":
      if (intent.commandType === "tuttiMode/update") {
        return settleUpdate(state, intent);
      }
      if (intent.commandType === "session/activate") {
        return settlePendingCreate(state, intent);
      }
      if (intent.commandType === "session/reconcile") {
        return settleOwnedReconcile(state, intent, context.sessionsById);
      }
      return unchanged(state);
    case "engine/intentExpired":
      return expirePendingCreate(state, intent.expiryId);
    case "session/snapshotReceived":
      return hydrateSessions(
        state,
        intent.sessions.map((session) => session.agentSessionId),
        context.sessionsById
      );
    case "session/upserted":
      return hydrateSessions(
        state,
        [intent.session.agentSessionId],
        context.sessionsById
      );
    case "session/removed":
      return removeSession(state, intent.agentSessionId);
    default:
      return unchanged(state);
  }
}

function setDraft(
  state: TuttiModeActivationState,
  intent: Extract<EngineIntent, { type: "tuttiMode/draftSet" }>
): EngineReducerResult<TuttiModeActivationState> {
  const draftKey = intent.draftKey.trim();
  if (!draftKey) return unchanged(state);
  if (!intent.active) {
    if (!state.draftsByKey[draftKey]) return unchanged(state);
    const draftsByKey = { ...state.draftsByKey };
    delete draftsByKey[draftKey];
    return { commands: NO_COMMANDS, state: { ...state, draftsByKey } };
  }
  const current = state.draftsByKey[draftKey];
  if (current?.active) return unchanged(state);
  return {
    commands: NO_COMMANDS,
    state: {
      ...state,
      draftsByKey: {
        ...state.draftsByKey,
        [draftKey]: {
          active: true,
          draftKey,
          occurredAtUnixMs: intent.occurredAtUnixMs,
          source: "slash_command"
        }
      }
    }
  };
}

function trackPendingCreate(
  state: TuttiModeActivationState,
  intent: Extract<EngineIntent, { type: "activation/requested" }>
): EngineReducerResult<TuttiModeActivationState> {
  if (
    intent.mode !== "new" ||
    !intent.initialTuttiModeActivation ||
    !intent.tuttiModeDraftKey?.trim()
  ) {
    return unchanged(state);
  }
  const agentSessionId = intent.agentSessionId.trim();
  const draftKey = intent.tuttiModeDraftKey.trim();
  if (!agentSessionId || !state.draftsByKey[draftKey]) return unchanged(state);
  return {
    commands: NO_COMMANDS,
    state: {
      ...state,
      pendingCreatesBySessionId: {
        ...state.pendingCreatesBySessionId,
        [agentSessionId]: {
          agentSessionId,
          draftKey,
          initialActivation: { ...intent.initialTuttiModeActivation },
          reconcileCommandId: null,
          requestId: intent.requestId,
          workspaceId: intent.workspaceId
        }
      }
    }
  };
}

function settlePendingCreate(
  state: TuttiModeActivationState,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>
): EngineReducerResult<TuttiModeActivationState> {
  const requestId = intent.correlationId?.trim() ?? "";
  const pending = Object.values(state.pendingCreatesBySessionId).find(
    (candidate) => candidate.requestId === requestId
  );
  if (!pending) return unchanged(state);
  if (intent.outcome === "succeeded") {
    const activation = activationFromCreateResult(intent.value, pending);
    if (activation) {
      const draftsByKey = { ...state.draftsByKey };
      const pendingCreatesBySessionId = { ...state.pendingCreatesBySessionId };
      delete draftsByKey[pending.draftKey];
      delete pendingCreatesBySessionId[pending.agentSessionId];
      return {
        commands: NO_COMMANDS,
        state: {
          ...state,
          activationsBySessionId: {
            ...state.activationsBySessionId,
            [pending.agentSessionId]: cloneActivation(activation)
          },
          draftsByKey,
          pendingCreatesBySessionId
        }
      };
    }
  }
  if (intent.outcome === "timedOut" || intent.outcome === "succeeded") {
    if (pending.reconcileCommandId) return unchanged(state);
    const reconcileCommandId = `tutti-mode-create-reconcile:${pending.requestId}`;
    return {
      commands: [
        {
          agentSessionId: pending.agentSessionId,
          commandId: reconcileCommandId,
          scope: "state",
          timeoutMs: UPDATE_TIMEOUT_MS,
          type: "session/reconcile",
          workspaceId: pending.workspaceId
        }
      ],
      state: {
        ...state,
        pendingCreatesBySessionId: {
          ...state.pendingCreatesBySessionId,
          [pending.agentSessionId]: { ...pending, reconcileCommandId }
        }
      }
    };
  }
  const pendingCreatesBySessionId = { ...state.pendingCreatesBySessionId };
  delete pendingCreatesBySessionId[pending.agentSessionId];
  return {
    commands: NO_COMMANDS,
    state: { ...state, pendingCreatesBySessionId }
  };
}

function requestUpdate(
  state: TuttiModeActivationState,
  intent: Extract<EngineIntent, { type: "tuttiMode/updateRequested" }>,
  sessionsById: Readonly<Record<string, CanonicalAgentSession>>
): EngineReducerResult<TuttiModeActivationState> {
  const agentSessionId = intent.agentSessionId.trim();
  const workspaceId = intent.workspaceId.trim();
  const commandId = intent.commandId.trim();
  const session = sessionsById[agentSessionId];
  if (
    !agentSessionId ||
    !workspaceId ||
    !commandId ||
    session?.workspaceId !== workspaceId ||
    !validSourcePair(intent.status, intent.source) ||
    state.updatesBySessionId[agentSessionId]?.updateStatus === "inFlight"
  ) {
    return unchanged(state);
  }
  const activation = state.activationsBySessionId[agentSessionId] ?? null;
  if (activation?.status === intent.status) {
    return clearUpdate(state, agentSessionId);
  }
  const expectedRevision = activation?.currentRevision.revision ?? null;
  const record: TuttiModeActivationUpdateRecord = {
    agentSessionId,
    commandId,
    errorCode: null,
    errorMessage: null,
    expectedRevision,
    reconcileCommandId: null,
    requestedAtUnixMs: intent.requestedAtUnixMs,
    source: intent.source,
    status: intent.status,
    updateStatus: "inFlight",
    workspaceId
  };
  return {
    commands: [
      {
        agentSessionId,
        commandId,
        ...(expectedRevision === null ? {} : { expectedRevision }),
        source: intent.source,
        status: intent.status,
        timeoutMs: UPDATE_TIMEOUT_MS,
        type: "tuttiMode/update",
        workspaceId
      }
    ],
    state: {
      ...state,
      updatesBySessionId: {
        ...state.updatesBySessionId,
        [agentSessionId]: record
      }
    }
  };
}

function settleUpdate(
  state: TuttiModeActivationState,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>
): EngineReducerResult<TuttiModeActivationState> {
  const entry = Object.values(state.updatesBySessionId).find(
    (candidate) => candidate.commandId === intent.commandId
  );
  if (!entry) return unchanged(state);
  if (intent.outcome === "succeeded") {
    const value = validUpdateResult(intent.value, entry);
    if (value) {
      const updatesBySessionId = { ...state.updatesBySessionId };
      delete updatesBySessionId[entry.agentSessionId];
      return {
        commands: NO_COMMANDS,
        state: {
          ...state,
          activationsBySessionId: {
            ...state.activationsBySessionId,
            [entry.agentSessionId]: cloneActivation(value.activation)
          },
          updatesBySessionId
        }
      };
    }
  }
  const uncertain =
    intent.outcome === "timedOut" ||
    intent.outcome === "succeeded" ||
    isRevisionConflict(intent.errorCode);
  return {
    commands: uncertain
      ? [
          {
            agentSessionId: entry.agentSessionId,
            commandId: `tutti-mode-reconcile:${entry.commandId}`,
            scope: "state",
            timeoutMs: UPDATE_TIMEOUT_MS,
            type: "session/reconcile",
            workspaceId: entry.workspaceId
          }
        ]
      : NO_COMMANDS,
    state: {
      ...state,
      updatesBySessionId: {
        ...state.updatesBySessionId,
        [entry.agentSessionId]: {
          ...entry,
          errorCode:
            intent.outcome === "succeeded"
              ? "invalid_command_result"
              : (intent.errorCode ?? null),
          errorMessage: intent.errorMessage?.trim() || null,
          reconcileCommandId: uncertain
            ? `tutti-mode-reconcile:${entry.commandId}`
            : null,
          updateStatus: uncertain ? "uncertain" : "failed"
        }
      }
    }
  };
}

function isRevisionConflict(errorCode: string | undefined): boolean {
  const normalized = errorCode?.trim().toLowerCase() ?? "";
  return (
    normalized.includes("409") ||
    normalized.includes("conflict") ||
    normalized.includes("revision")
  );
}

function hydrateSessions(
  state: TuttiModeActivationState,
  sessionIds: readonly string[],
  sessionsById: Readonly<Record<string, CanonicalAgentSession>>
): EngineReducerResult<TuttiModeActivationState> {
  let changed = false;
  const activationsBySessionId = { ...state.activationsBySessionId };
  const draftsByKey = { ...state.draftsByKey };
  const pendingCreatesBySessionId = { ...state.pendingCreatesBySessionId };
  const updatesBySessionId = { ...state.updatesBySessionId };
  for (const rawId of sessionIds) {
    const agentSessionId = rawId.trim();
    const session = sessionsById[agentSessionId];
    if (!session) continue;
    const activation = session.tuttiModeActivation
      ? cloneActivation(session.tuttiModeActivation)
      : null;
    const current = activationsBySessionId[agentSessionId];
    if (!sameActivation(current, activation)) {
      activationsBySessionId[agentSessionId] = activation;
      changed = true;
    }
    const pending = pendingCreatesBySessionId[agentSessionId];
    if (
      pending &&
      activation?.status === pending.initialActivation.status &&
      activation.currentRevision.status === pending.initialActivation.status
    ) {
      delete draftsByKey[pending.draftKey];
      delete pendingCreatesBySessionId[agentSessionId];
      changed = true;
    }
    const update = updatesBySessionId[agentSessionId];
    if (update && updateSemanticallyApplied(update, activation)) {
      delete updatesBySessionId[agentSessionId];
      changed = true;
    }
  }
  return changed
    ? {
        commands: NO_COMMANDS,
        state: {
          activationsBySessionId,
          draftsByKey,
          pendingCreatesBySessionId,
          updatesBySessionId
        }
      }
    : unchanged(state);
}

function settleOwnedReconcile(
  state: TuttiModeActivationState,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>,
  sessionsById: Readonly<Record<string, CanonicalAgentSession>>
): EngineReducerResult<TuttiModeActivationState> {
  const update = Object.values(state.updatesBySessionId).find(
    (candidate) => candidate.reconcileCommandId === intent.commandId
  );
  if (update) {
    const activation =
      sessionsById[update.agentSessionId]?.tuttiModeActivation ?? null;
    if (
      intent.outcome === "succeeded" &&
      updateSemanticallyApplied(update, activation)
    ) {
      return clearUpdate(state, update.agentSessionId);
    }
    return {
      commands: NO_COMMANDS,
      state: {
        ...state,
        updatesBySessionId: {
          ...state.updatesBySessionId,
          [update.agentSessionId]: {
            ...update,
            errorCode:
              intent.outcome === "succeeded"
                ? "tutti_mode_update_not_applied"
                : intent.errorCode?.trim() || "tutti_mode_reconcile_failed",
            errorMessage: intent.errorMessage?.trim() || null,
            reconcileCommandId: null,
            updateStatus: "failed"
          }
        }
      }
    };
  }
  const pending = Object.values(state.pendingCreatesBySessionId).find(
    (candidate) => candidate.reconcileCommandId === intent.commandId
  );
  if (!pending) return unchanged(state);
  if (intent.outcome !== "succeeded") {
    return {
      commands: NO_COMMANDS,
      state: {
        ...state,
        pendingCreatesBySessionId: {
          ...state.pendingCreatesBySessionId,
          [pending.agentSessionId]: {
            ...pending,
            reconcileCommandId: null
          }
        }
      }
    };
  }
  const activation =
    sessionsById[pending.agentSessionId]?.tuttiModeActivation ?? null;
  if (activation?.status === pending.initialActivation.status) {
    const draftsByKey = { ...state.draftsByKey };
    const pendingCreatesBySessionId = { ...state.pendingCreatesBySessionId };
    delete draftsByKey[pending.draftKey];
    delete pendingCreatesBySessionId[pending.agentSessionId];
    return {
      commands: NO_COMMANDS,
      state: {
        ...state,
        activationsBySessionId: {
          ...state.activationsBySessionId,
          [pending.agentSessionId]: cloneActivation(activation)
        },
        draftsByKey,
        pendingCreatesBySessionId
      }
    };
  }
  const pendingCreatesBySessionId = { ...state.pendingCreatesBySessionId };
  delete pendingCreatesBySessionId[pending.agentSessionId];
  return {
    commands: NO_COMMANDS,
    state: { ...state, pendingCreatesBySessionId }
  };
}

function expirePendingCreate(
  state: TuttiModeActivationState,
  expiryId: string
): EngineReducerResult<TuttiModeActivationState> {
  if (!expiryId.startsWith("activation:")) return unchanged(state);
  const requestId = expiryId.slice("activation:".length);
  const pending = Object.values(state.pendingCreatesBySessionId).find(
    (candidate) => candidate.requestId === requestId
  );
  if (!pending) return unchanged(state);
  const pendingCreatesBySessionId = { ...state.pendingCreatesBySessionId };
  delete pendingCreatesBySessionId[pending.agentSessionId];
  return {
    commands: NO_COMMANDS,
    state: { ...state, pendingCreatesBySessionId }
  };
}

function updateSemanticallyApplied(
  update: TuttiModeActivationUpdateRecord,
  activation: AgentActivitySession["tuttiModeActivation"]
): boolean {
  return Boolean(
    activation &&
    activation.status === update.status &&
    activation.currentRevision.status === update.status &&
    activation.currentRevision.revision > (update.expectedRevision ?? 0)
  );
}

function removeSession(
  state: TuttiModeActivationState,
  agentSessionId: string
): EngineReducerResult<TuttiModeActivationState> {
  const id = agentSessionId.trim();
  if (
    !(id in state.activationsBySessionId) &&
    !state.pendingCreatesBySessionId[id] &&
    !state.updatesBySessionId[id]
  ) {
    return unchanged(state);
  }
  const activationsBySessionId = { ...state.activationsBySessionId };
  const pendingCreatesBySessionId = { ...state.pendingCreatesBySessionId };
  const updatesBySessionId = { ...state.updatesBySessionId };
  delete activationsBySessionId[id];
  delete pendingCreatesBySessionId[id];
  delete updatesBySessionId[id];
  return {
    commands: NO_COMMANDS,
    state: {
      ...state,
      activationsBySessionId,
      pendingCreatesBySessionId,
      updatesBySessionId
    }
  };
}

function clearUpdate(
  state: TuttiModeActivationState,
  agentSessionId: string
): EngineReducerResult<TuttiModeActivationState> {
  if (!state.updatesBySessionId[agentSessionId]) return unchanged(state);
  const updatesBySessionId = { ...state.updatesBySessionId };
  delete updatesBySessionId[agentSessionId];
  return { commands: NO_COMMANDS, state: { ...state, updatesBySessionId } };
}

function validSourcePair(status: string, source: string): boolean {
  return (
    (status === "active" && source === "slash_command") ||
    (status === "inactive" && source === "badge_remove")
  );
}

function validUpdateResult(
  value: unknown,
  entry: TuttiModeActivationUpdateRecord
): {
  activation: NonNullable<AgentActivitySession["tuttiModeActivation"]>;
} | null {
  if (!value || typeof value !== "object") return null;
  const activation = (value as { activation?: unknown }).activation;
  if (!activation || typeof activation !== "object") return null;
  const candidate = activation as NonNullable<
    AgentActivitySession["tuttiModeActivation"]
  >;
  return candidate.workspaceId === entry.workspaceId &&
    candidate.agentSessionId === entry.agentSessionId &&
    candidate.status === entry.status &&
    candidate.currentRevision?.status === entry.status &&
    Number.isInteger(candidate.currentRevision?.revision)
    ? { activation: candidate }
    : null;
}

function activationFromCreateResult(
  value: unknown,
  pending: TuttiModeActivationState["pendingCreatesBySessionId"][string]
): NonNullable<AgentActivitySession["tuttiModeActivation"]> | null {
  if (!value || typeof value !== "object") return null;
  const session = (value as { session?: unknown }).session;
  if (!session || typeof session !== "object") return null;
  const candidate = session as Partial<AgentActivitySession>;
  const activation = candidate.tuttiModeActivation;
  return candidate.workspaceId === pending.workspaceId &&
    candidate.agentSessionId === pending.agentSessionId &&
    activation?.workspaceId === pending.workspaceId &&
    activation.agentSessionId === pending.agentSessionId &&
    activation.status === pending.initialActivation.status &&
    activation.currentRevision.status === pending.initialActivation.status
    ? activation
    : null;
}

function cloneActivation(
  activation: NonNullable<AgentActivitySession["tuttiModeActivation"]>
): NonNullable<AgentActivitySession["tuttiModeActivation"]> {
  return {
    ...activation,
    currentRevision: { ...activation.currentRevision }
  };
}

function sameActivation(
  left: AgentActivitySession["tuttiModeActivation"] | undefined,
  right: AgentActivitySession["tuttiModeActivation"]
): boolean {
  return (
    left === right ||
    (left?.id === right?.id &&
      left?.status === right?.status &&
      left?.currentRevision.revision === right?.currentRevision.revision)
  );
}

function unchanged(
  state: TuttiModeActivationState
): EngineReducerResult<TuttiModeActivationState> {
  return { commands: NO_COMMANDS, state };
}
