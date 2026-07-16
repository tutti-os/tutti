import type { AgentActivitySessionInput } from "../sessionNormalization.ts";
import type { SendInputResultValidation } from "./commandResult.validation.ts";
import type { ScopedSessionResultValidation } from "./commandResult.validation.ts";
import type {
  PendingActivationIntentRecord,
  PendingIntentsState,
  SessionActivationRequestedIntent
} from "./pendingIntents.types.ts";
import {
  confirmFromMessages,
  confirmFromSessions,
  deleteSubmit,
  expireSubmit,
  removeSubmit,
  requestSubmit,
  settleSubmitCommand,
  submitExpiryId
} from "./pendingSubmit.reducer.ts";
import type {
  EngineCommand,
  EngineCommandResultIntent,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];
const ACTIVATION_COMMAND_TIMEOUT_MS = 30_000;

export function createInitialPendingIntentsState(): PendingIntentsState {
  return {
    activationsByRequestId: {},
    inactiveSessionIds: {},
    submitsByClientSubmitId: {}
  };
}

export function pendingIntentsReducer(
  state: PendingIntentsState,
  intent: EngineIntent,
  context: {
    deletedSessionIds: Readonly<Record<string, true>>;
    turnsById: Readonly<
      Record<string, import("../types.ts").AgentActivityTurn>
    >;
    submitCancellationAccepted?: boolean;
    sendResultValidation?: SendInputResultValidation | null;
    settingsResultValidation?: ScopedSessionResultValidation | null;
    planFeedbackAccepted?: boolean;
    submitRequestAccepted?: boolean;
    submitDeliveryIsQueuePending?: boolean;
  } = {
    deletedSessionIds: {},
    turnsById: {}
  }
): EngineReducerResult<PendingIntentsState> {
  switch (intent.type) {
    case "activation/requested":
      if (context.deletedSessionIds[intent.agentSessionId.trim()]) {
        return unchanged(state);
      }
      return requestActivation(state, intent);
    case "activation/dismissed":
      return removeActivation(state, intent.requestId);
    case "activation/settingsPatched":
      return patchActivationSettings(state, intent);
    case "activation/failureRecorded":
      return recordActivationFailure(state, intent);
    case "activation/failureCleared":
      return clearActivationFailure(state, intent.agentSessionId);
    case "activation/unactivateRequested":
      return requestUnactivation(state, intent);
    case "submit/requested":
      if (context.submitRequestAccepted === false) return unchanged(state);
      if (context.deletedSessionIds[intent.agentSessionId.trim()]) {
        return unchanged(state);
      }
      return requestSubmit(state, intent);
    case "plan/feedbackRequested":
      return context.planFeedbackAccepted === true
        ? requestSubmit(state, {
            ...intent,
            type: "submit/requested"
          })
        : unchanged(state);
    case "submit/dismissed":
      return removeSubmit(state, intent.clientSubmitId);
    case "submit/canceled":
      return context.submitCancellationAccepted === true
        ? removeSubmit(state, intent.clientSubmitId)
        : unchanged(state);
    case "message/snapshotReceived":
      return confirmFromMessages(state, intent.messages);
    case "session/snapshotReceived":
      return receiveSessionSnapshot(state, intent.sessions, context.turnsById);
    case "session/upserted":
      return confirmActivationsFromSessions(state, [intent.session]);
    case "turn/upserted":
      return confirmFromSessions(state, context.turnsById);
    case "engine/commandResult":
      if (intent.commandType === "queue/sendPrompt") {
        const settled = settleSubmitCommand(
          state,
          intent,
          context.sendResultValidation ?? null
        );
        if (intent.outcome !== "succeeded") return settled;
        const confirmed = confirmFromSessions(settled.state, context.turnsById);
        return {
          commands: [...settled.commands, ...confirmed.commands],
          state: confirmed.state
        };
      }
      return intent.commandType === "session/activate"
        ? settleActivationCommand(state, intent)
        : intent.commandType === "session/updateSettings"
          ? settleActivationSettingsCommand(
              state,
              intent,
              context.settingsResultValidation ?? null
            )
          : unchanged(state);
    case "engine/intentExpired":
      return intent.expiryId.startsWith("activation:")
        ? expireActivation(state, intent.expiryId)
        : expireSubmit(state, intent.expiryId, {
            deliveryIsQueuePending:
              context.submitDeliveryIsQueuePending === true,
            dueAtUnixMs: intent.dueAtUnixMs
          });
    case "session/removed":
      return removeSessionIntents(state, intent.agentSessionId);
    default:
      return unchanged(state);
  }
}

function patchActivationSettings(
  state: PendingIntentsState,
  intent: Extract<EngineIntent, { type: "activation/settingsPatched" }>
): EngineReducerResult<PendingIntentsState> {
  const agentSessionId = intent.agentSessionId.trim();
  const record = Object.values(state.activationsByRequestId)
    .filter(
      (candidate) =>
        candidate.agentSessionId === agentSessionId &&
        candidate.mode === "new" &&
        candidate.status !== "failed"
    )
    .sort((left, right) => right.requestedAtUnixMs - left.requestedAtUnixMs)[0];
  if (!record) return unchanged(state);
  const patchedRecord: PendingActivationIntentRecord = {
    ...record,
    pendingSettingsPatch: {
      ...(record.pendingSettingsPatch ?? {}),
      ...intent.settings
    },
    settings: { ...(record.settings ?? {}), ...intent.settings },
    settingsUpdateStatus: undefined
  };
  if (record.status === "confirmed") {
    const attached = attachPendingActivationSettings(patchedRecord);
    return {
      commands: attached.commands,
      state: replaceActivation(state, attached.record)
    };
  }
  return {
    commands: NO_COMMANDS,
    state: replaceActivation(state, patchedRecord)
  };
}

function requestActivation(
  state: PendingIntentsState,
  intent: SessionActivationRequestedIntent
): EngineReducerResult<PendingIntentsState> {
  const requestId = intent.requestId.trim();
  const agentSessionId = intent.agentSessionId.trim();
  const workspaceId = intent.workspaceId.trim();
  const agentTargetId = intent.agentTargetId?.trim() || null;
  const clientSubmitId =
    intent.mode === "new" ? intent.clientSubmitId.trim() : null;
  if (
    !requestId ||
    !agentSessionId ||
    !workspaceId ||
    state.activationsByRequestId[requestId] ||
    (intent.mode === "new" && (!agentTargetId || !clientSubmitId))
  ) {
    return unchanged(state);
  }
  const content = (intent.content ?? []).map((block) => ({ ...block }));
  const displayPrompt = intent.initialDisplayPrompt?.trim() || undefined;
  const optimisticTitle =
    intent.mode === "new"
      ? intent.optimisticTitle?.trim() || undefined
      : undefined;
  const runtimeContent = (intent.runtimeContent ?? content).map((block) => ({
    ...block
  }));
  const supersededRequestIds = Object.values(state.activationsByRequestId)
    .filter(
      (record) =>
        record.agentSessionId === agentSessionId && record.status !== "failed"
    )
    .map((record) => record.requestId);
  const baseState = supersededRequestIds.reduce(deleteActivation, state);
  const recordBase = {
    agentSessionId,
    content,
    cwd: intent.cwd?.trim() ?? "",
    ...(displayPrompt ? { displayPrompt } : {}),
    errorCode: null,
    errorMessage: null,
    expiresAtUnixMs: intent.expiresAtUnixMs,
    initialTurnExpected: runtimeContent.length > 0,
    ...(intent.submitDiagnostics
      ? { submitDiagnostics: { ...intent.submitDiagnostics } }
      : {}),
    requestedAtUnixMs: intent.requestedAtUnixMs,
    requestId,
    ...(intent.settings ? { settings: { ...intent.settings } } : {}),
    status: "requested" as const,
    title: intent.title?.trim() || null,
    workspaceId
  };
  const record: PendingActivationIntentRecord =
    intent.mode === "new"
      ? {
          ...recordBase,
          agentTargetId: agentTargetId!,
          clientSubmitId: clientSubmitId!,
          mode: "new",
          ...(optimisticTitle ? { optimisticTitle } : {})
        }
      : {
          ...recordBase,
          agentTargetId,
          clientSubmitId: null,
          mode: "existing"
        };
  return {
    commands: [
      ...supersededRequestIds.map((id) => ({
        expiryId: activationExpiryId(id),
        type: "engine/cancelExpiry" as const
      })),
      {
        dueAtUnixMs: intent.expiresAtUnixMs,
        expiryId: activationExpiryId(requestId),
        type: "engine/scheduleExpiry"
      },
      intent.mode === "new"
        ? {
            agentSessionId,
            agentTargetId: agentTargetId!,
            commandId: `activate:${requestId}`,
            clientSubmitId: clientSubmitId!,
            correlationId: requestId,
            ...(intent.cwd !== undefined ? { cwd: intent.cwd } : {}),
            ...(runtimeContent.length > 0
              ? { initialContent: runtimeContent }
              : {}),
            ...(displayPrompt ? { initialDisplayPrompt: displayPrompt } : {}),
            ...(intent.submitDiagnostics
              ? { submitDiagnostics: { ...intent.submitDiagnostics } }
              : {}),
            mode: "new" as const,
            ...(intent.settings ? { settings: { ...intent.settings } } : {}),
            timeoutMs: ACTIVATION_COMMAND_TIMEOUT_MS,
            ...(intent.title?.trim() ? { title: intent.title.trim() } : {}),
            type: "session/activate",
            ...(intent.visible !== undefined
              ? { visible: intent.visible }
              : {}),
            workspaceId
          }
        : {
            agentSessionId,
            ...(agentTargetId ? { agentTargetId } : {}),
            commandId: `activate:${requestId}`,
            correlationId: requestId,
            ...(intent.cwd !== undefined ? { cwd: intent.cwd } : {}),
            ...(runtimeContent.length > 0
              ? { initialContent: runtimeContent }
              : {}),
            ...(displayPrompt ? { initialDisplayPrompt: displayPrompt } : {}),
            ...(intent.submitDiagnostics
              ? { submitDiagnostics: { ...intent.submitDiagnostics } }
              : {}),
            mode: "existing" as const,
            ...(intent.settings ? { settings: { ...intent.settings } } : {}),
            timeoutMs: ACTIVATION_COMMAND_TIMEOUT_MS,
            ...(intent.title?.trim() ? { title: intent.title.trim() } : {}),
            type: "session/activate" as const,
            ...(intent.visible !== undefined
              ? { visible: intent.visible }
              : {}),
            workspaceId
          }
    ],
    state: replaceActivation(
      markSessionActive(baseState, agentSessionId),
      record
    )
  };
}

function recordActivationFailure(
  state: PendingIntentsState,
  intent: Extract<EngineIntent, { type: "activation/failureRecorded" }>
): EngineReducerResult<PendingIntentsState> {
  const agentSessionId = intent.agentSessionId.trim();
  const requestId = intent.requestId.trim();
  if (
    !agentSessionId ||
    !requestId ||
    state.activationsByRequestId[requestId]
  ) {
    return unchanged(state);
  }
  return {
    commands: NO_COMMANDS,
    state: replaceActivation(state, {
      agentSessionId,
      agentTargetId: null,
      clientSubmitId: null,
      content: [],
      cwd: "",
      errorCode: intent.errorCode?.trim() || null,
      errorMessage: intent.errorMessage.trim() || null,
      expiresAtUnixMs: Number.MAX_SAFE_INTEGER,
      initialTurnExpected: false,
      mode: "existing",
      requestedAtUnixMs: intent.occurredAtUnixMs,
      requestId,
      status: "failed",
      title: null,
      workspaceId: intent.workspaceId
    })
  };
}

function clearActivationFailure(
  state: PendingIntentsState,
  agentSessionId: string
): EngineReducerResult<PendingIntentsState> {
  const ids = Object.values(state.activationsByRequestId)
    .filter(
      (record) =>
        record.agentSessionId === agentSessionId.trim() &&
        record.status === "failed"
    )
    .map((record) => record.requestId);
  if (ids.length === 0) {
    return unchanged(state);
  }
  return {
    commands: ids
      .filter(
        (id) =>
          state.activationsByRequestId[id]?.expiresAtUnixMs !==
          Number.MAX_SAFE_INTEGER
      )
      .map((id) => ({
        expiryId: activationExpiryId(id),
        type: "engine/cancelExpiry" as const
      })),
    state: ids.reduce(deleteActivation, state)
  };
}

function requestUnactivation(
  state: PendingIntentsState,
  intent: Extract<EngineIntent, { type: "activation/unactivateRequested" }>
): EngineReducerResult<PendingIntentsState> {
  const agentSessionId = intent.agentSessionId.trim();
  if (!agentSessionId || !intent.workspaceId.trim()) {
    return unchanged(state);
  }
  const activationIds = Object.values(state.activationsByRequestId)
    .filter((record) => record.agentSessionId === agentSessionId)
    .map((record) => record.requestId);
  return {
    commands: [
      ...activationIds
        .filter(
          (id) =>
            state.activationsByRequestId[id]?.expiresAtUnixMs !==
            Number.MAX_SAFE_INTEGER
        )
        .map((id) => ({
          expiryId: activationExpiryId(id),
          type: "engine/cancelExpiry" as const
        })),
      {
        agentSessionId,
        commandId: intent.commandId,
        type: "session/unactivate" as const,
        workspaceId: intent.workspaceId
      }
    ],
    state: markSessionInactive(
      activationIds.reduce(deleteActivation, state),
      agentSessionId
    )
  };
}

function settleActivationCommand(
  state: PendingIntentsState,
  intent: EngineCommandResultIntent
): EngineReducerResult<PendingIntentsState> {
  const requestId = intent.correlationId?.trim() ?? "";
  const record = state.activationsByRequestId[requestId];
  if (!record) {
    return unchanged(state);
  }
  if (
    intent.outcome === "succeeded" &&
    isActivationCommandResult(intent.value)
  ) {
    const result = intent.value;
    const failed = result.activation.status === "failed";
    return {
      commands: NO_COMMANDS,
      state: replaceActivation(
        markSessionActive(state, record.agentSessionId),
        {
          ...record,
          errorCode: failed ? result.error?.code?.trim() || null : null,
          errorMessage: failed ? result.error?.message?.trim() || null : null,
          status: failed ? "failed" : record.status
        }
      )
    };
  }
  if (intent.outcome === "succeeded") {
    return {
      commands: NO_COMMANDS,
      state: replaceActivation(state, {
        ...record,
        errorCode: "invalid_command_result",
        errorMessage: null,
        status: "uncertain"
      })
    };
  }
  return {
    commands: NO_COMMANDS,
    state: replaceActivation(state, {
      ...record,
      errorCode: intent.errorCode ?? null,
      errorMessage:
        intent.outcome === "timedOut"
          ? null
          : intent.errorMessage?.trim() || null,
      status: intent.outcome === "timedOut" ? "uncertain" : "failed"
    })
  };
}

function receiveSessionSnapshot(
  state: PendingIntentsState,
  sessions: readonly AgentActivitySessionInput[],
  turnsById: Readonly<Record<string, import("../types.ts").AgentActivityTurn>>
): EngineReducerResult<PendingIntentsState> {
  const activationResult = confirmActivationsFromSessions(state, sessions);
  const submitResult = confirmFromSessions(activationResult.state, turnsById);
  return {
    commands: [...activationResult.commands, ...submitResult.commands],
    state: submitResult.state
  };
}

function confirmActivationsFromSessions(
  state: PendingIntentsState,
  sessions: readonly AgentActivitySessionInput[]
): EngineReducerResult<PendingIntentsState> {
  const sessionsById = new Map(
    sessions.map((session) => [session.agentSessionId, session])
  );
  const commands: EngineCommand[] = [];
  let next = state;
  for (const record of Object.values(state.activationsByRequestId)) {
    if (record.status !== "requested" && record.status !== "uncertain") {
      continue;
    }
    const session = sessionsById.get(record.agentSessionId);
    if (
      !session ||
      session.workspaceId.trim() !== record.workspaceId ||
      (record.mode === "new" &&
        (session.createdAtUnixMs === undefined ||
          session.createdAtUnixMs < record.requestedAtUnixMs))
    ) {
      continue;
    }
    const settingsUpdate = attachPendingActivationSettings(record);
    next = replaceActivation(markSessionActive(next, record.agentSessionId), {
      ...settingsUpdate.record,
      errorMessage: null,
      status: "confirmed"
    });
    commands.push(...settingsUpdate.commands);
  }
  return next === state ? unchanged(state) : { commands, state: next };
}

function attachPendingActivationSettings(
  record: PendingActivationIntentRecord
): {
  commands: readonly EngineCommand[];
  record: PendingActivationIntentRecord;
} {
  const settings = record.pendingSettingsPatch;
  if (
    !settings ||
    Object.keys(settings).length === 0 ||
    record.settingsUpdateStatus === "inFlight"
  ) {
    return { commands: NO_COMMANDS, record };
  }
  return {
    commands: [
      {
        agentSessionId: record.agentSessionId,
        commandId: `activation-settings:${record.requestId}`,
        correlationId: record.requestId,
        settings: { ...settings },
        type: "session/updateSettings",
        workspaceId: record.workspaceId
      }
    ],
    record: { ...record, settingsUpdateStatus: "inFlight" }
  };
}

function settleActivationSettingsCommand(
  state: PendingIntentsState,
  intent: EngineCommandResultIntent,
  validation: ScopedSessionResultValidation | null
): EngineReducerResult<PendingIntentsState> {
  const requestId = intent.correlationId?.trim() ?? "";
  const record = state.activationsByRequestId[requestId];
  if (
    !record ||
    record.settingsUpdateStatus !== "inFlight" ||
    intent.commandId !== `activation-settings:${requestId}`
  ) {
    return unchanged(state);
  }
  if (intent.outcome === "succeeded" && validation?.kind === "valid") {
    const {
      pendingSettingsPatch: _patch,
      settingsUpdateStatus: _status,
      ...next
    } = record;
    return { commands: NO_COMMANDS, state: replaceActivation(state, next) };
  }
  return {
    commands: NO_COMMANDS,
    state: replaceActivation(state, {
      ...record,
      errorCode:
        intent.outcome === "succeeded"
          ? "invalid_command_result"
          : intent.errorCode?.trim() || "settings_update_failed",
      errorMessage: intent.errorMessage?.trim() || null,
      settingsUpdateStatus:
        intent.outcome === "timedOut" || intent.outcome === "succeeded"
          ? "unknown"
          : "failed"
    })
  };
}

function expireActivation(
  state: PendingIntentsState,
  expiryId: string
): EngineReducerResult<PendingIntentsState> {
  const requestId = expiryId.slice("activation:".length);
  const record = state.activationsByRequestId[requestId];
  if (!record) {
    return unchanged(state);
  }
  if (record.status === "confirmed") {
    return unchanged(state);
  }
  return {
    commands: NO_COMMANDS,
    state: replaceActivation(state, {
      ...record,
      errorCode: record.errorCode ?? "activation_confirmation_expired",
      errorMessage: record.errorMessage,
      status: "failed"
    })
  };
}

function removeActivation(
  state: PendingIntentsState,
  requestId: string
): EngineReducerResult<PendingIntentsState> {
  const id = requestId.trim();
  if (!state.activationsByRequestId[id]) {
    return unchanged(state);
  }
  return {
    commands: [
      { expiryId: activationExpiryId(id), type: "engine/cancelExpiry" }
    ],
    state: deleteActivation(state, id)
  };
}

function removeSessionIntents(
  state: PendingIntentsState,
  agentSessionId: string
): EngineReducerResult<PendingIntentsState> {
  const submitIds = Object.values(state.submitsByClientSubmitId)
    .filter((record) => record.agentSessionId === agentSessionId.trim())
    .map((record) => record.clientSubmitId);
  const activationIds = Object.values(state.activationsByRequestId)
    .filter((record) => record.agentSessionId === agentSessionId.trim())
    .map((record) => record.requestId);
  const wasInactive = state.inactiveSessionIds[agentSessionId.trim()] === true;
  if (submitIds.length === 0 && activationIds.length === 0 && !wasInactive) {
    return unchanged(state);
  }
  return {
    commands: [
      ...submitIds.map((id) => ({
        expiryId: submitExpiryId(id),
        type: "engine/cancelExpiry" as const
      })),
      ...activationIds.map((id) => ({
        expiryId: activationExpiryId(id),
        type: "engine/cancelExpiry" as const
      }))
    ],
    state: removeInactiveSession(
      activationIds.reduce(
        deleteActivation,
        submitIds.reduce(deleteSubmit, state)
      ),
      agentSessionId
    )
  };
}

function isActivationCommandResult(value: unknown): value is {
  activation: { status: string };
  error?: { code?: string; message?: string } | null;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as {
    activation?: { status?: unknown };
    error?: { code?: string; message?: string } | null;
  };
  return Boolean(
    result.activation && typeof result.activation.status === "string"
  );
}

function activationExpiryId(requestId: string): string {
  return `activation:${requestId}`;
}

function replaceActivation(
  state: PendingIntentsState,
  record: PendingActivationIntentRecord
): PendingIntentsState {
  return {
    ...state,
    activationsByRequestId: {
      ...state.activationsByRequestId,
      [record.requestId]: record
    }
  };
}

function deleteActivation(
  state: PendingIntentsState,
  requestId: string
): PendingIntentsState {
  const activations = { ...state.activationsByRequestId };
  delete activations[requestId];
  return { ...state, activationsByRequestId: activations };
}

function markSessionActive(
  state: PendingIntentsState,
  agentSessionId: string
): PendingIntentsState {
  return removeInactiveSession(state, agentSessionId);
}

function markSessionInactive(
  state: PendingIntentsState,
  agentSessionId: string
): PendingIntentsState {
  const id = agentSessionId.trim();
  return state.inactiveSessionIds[id]
    ? state
    : {
        ...state,
        inactiveSessionIds: { ...state.inactiveSessionIds, [id]: true }
      };
}

function removeInactiveSession(
  state: PendingIntentsState,
  agentSessionId: string
): PendingIntentsState {
  const id = agentSessionId.trim();
  if (!state.inactiveSessionIds[id]) {
    return state;
  }
  const inactiveSessionIds = { ...state.inactiveSessionIds };
  delete inactiveSessionIds[id];
  return { ...state, inactiveSessionIds };
}

function unchanged(
  state: PendingIntentsState
): EngineReducerResult<PendingIntentsState> {
  return { commands: NO_COMMANDS, state };
}
