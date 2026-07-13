import type { AgentActivityMessage } from "../types.ts";
import type { AgentActivitySessionInput } from "../sessionNormalization.ts";
import type {
  EngineCommand,
  EngineCommandResultIntent,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import type {
  PromptQueueIntent,
  PromptQueueRecord,
  PromptQueueState
} from "./promptQueue.types.ts";
import {
  carryPromptQueueObservedTurnForward,
  observedSettledTurnAfterQueueSend,
  promptQueueAvailabilityEqual,
  promptQueueAvailabilityFromSession,
  promptQueueAvailabilityMapsEqual,
  shouldAcceptPromptQueueAvailability
} from "./promptQueue.availability.ts";
import type { CancelResultValidation } from "./commandResult.validation.ts";
import { promptQueuePromptIdForClientSubmit } from "./promptQueue.lookup.ts";
import { normalizeQueuedPrompt } from "./promptQueue.prompt.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];
const QUEUE_SEND_TIMEOUT_MS = 30_000;

export { createInitialPromptQueueState } from "./promptQueue.initialState.ts";

export function promptQueueReducer(
  state: PromptQueueState,
  intent: EngineIntent,
  context: {
    deletedSessionIds: Readonly<Record<string, true>>;
    planFeedbackAccepted?: boolean;
    submitRequestAccepted?: boolean;
    cancelResultValidation?: CancelResultValidation | null;
  } = { deletedSessionIds: {} }
): EngineReducerResult<PromptQueueState> {
  switch (intent.type) {
    case "session/snapshotReceived":
      return receiveSessionSnapshot(
        state,
        intent.sessions.filter(
          (session) => !context.deletedSessionIds[session.agentSessionId.trim()]
        )
      );
    case "session/upserted":
      if (context.deletedSessionIds[intent.session.agentSessionId.trim()]) {
        return unchanged(state);
      }
      return receiveSessionSnapshot(state, [intent.session], false);
    case "session/removed":
      return removeSession(state, intent.agentSessionId);
    case "queue/sessionCleaned":
      return removeQueue(state, intent.agentSessionId);
    case "queue/enqueued":
      if (context.deletedSessionIds[intent.agentSessionId.trim()]) {
        return unchanged(state);
      }
      return enqueuePrompt(state, intent);
    case "submit/requested":
      if (context.submitRequestAccepted === false) return unchanged(state);
      if (context.deletedSessionIds[intent.agentSessionId.trim()]) {
        return unchanged(state);
      }
      return enqueueSubmit(state, intent);
    case "plan/feedbackRequested":
      return context.planFeedbackAccepted === true
        ? enqueueSubmit(state, { ...intent, type: "submit/requested" })
        : unchanged(state);
    case "submit/canceled":
      return removePrompt(
        state,
        intent.agentSessionId,
        promptQueuePromptIdForClientSubmit(
          state,
          intent.agentSessionId,
          intent.clientSubmitId
        ) ?? ""
      );
    case "message/snapshotReceived":
      return confirmDeliveredPrompts(state, intent.messages);
    case "engine/intentExpired":
      return expireUncertainDelivery(state, intent.expiryId);
    case "queue/removed":
      return removePrompt(state, intent.agentSessionId, intent.promptId);
    case "queue/promoted":
      if (context.deletedSessionIds[intent.agentSessionId.trim()]) {
        return unchanged(state);
      }
      return promotePrompt(state, intent.agentSessionId, intent.promptId);
    case "queue/suspended":
      return suspendQueue(state, intent.agentSessionId, intent.reason);
    case "queue/resumed":
      if (context.deletedSessionIds[intent.agentSessionId.trim()]) {
        return unchanged(state);
      }
      return resumeQueue(state, intent.agentSessionId);
    case "engine/commandResult":
      if (intent.commandType === "turn/cancel") {
        return receiveTurnCancelResult(
          state,
          intent,
          context.cancelResultValidation ?? null
        );
      }
      return intent.commandType === "queue/sendPrompt"
        ? settleQueueCommand(state, intent)
        : unchanged(state);
    default:
      return unchanged(state);
  }
}

function receiveSessionSnapshot(
  state: PromptQueueState,
  sessions: readonly AgentActivitySessionInput[],
  markMissing = true
): EngineReducerResult<PromptQueueState> {
  const sessionsById = new Map(
    sessions.map((session) => [session.agentSessionId.trim(), session])
  );
  const receivedAvailability = Object.fromEntries(
    [...sessionsById].map(([agentSessionId, session]) => {
      const incoming = promptQueueAvailabilityFromSession(session);
      const current = state.availabilityBySessionId[agentSessionId];
      return [
        agentSessionId,
        current && !shouldAcceptPromptQueueAvailability(current, incoming)
          ? current
          : incoming
      ];
    })
  );
  const nextAvailabilityBySessionId = markMissing
    ? receivedAvailability
    : { ...state.availabilityBySessionId, ...receivedAvailability };
  let nextState = promptQueueAvailabilityMapsEqual(
    state.availabilityBySessionId,
    nextAvailabilityBySessionId
  )
    ? state
    : { ...state, availabilityBySessionId: nextAvailabilityBySessionId };
  const commands: EngineCommand[] = [];
  for (const [agentSessionId, current] of Object.entries(
    state.recordsBySessionId
  )) {
    const session = sessionsById.get(agentSessionId);
    if (!session && !markMissing) {
      continue;
    }
    const rawIncomingAvailability = session
      ? promptQueueAvailabilityFromSession(session)
      : {
          activeTurnId: null,
          lastTurnId: null,
          lastTurnVersion: null,
          sessionVersion: null,
          state: "missing" as const
        };
    const incomingAvailability = carryPromptQueueObservedTurnForward(
      current.availability,
      rawIncomingAvailability
    );
    const availability = shouldAcceptPromptQueueAvailability(
      current.availability,
      incomingAvailability
    )
      ? incomingAvailability
      : current.availability;
    if (promptQueueAvailabilityEqual(current.availability, availability)) {
      continue;
    }
    const updated = { ...current, availability };
    nextState = replaceRecord(nextState, agentSessionId, updated);
    const started = startEligibleCommand(nextState, updated);
    nextState = started.state;
    commands.push(...started.commands);
  }
  return nextState === state && commands.length === 0
    ? unchanged(state)
    : { commands, state: nextState };
}

function enqueuePrompt(
  state: PromptQueueState,
  intent: Extract<PromptQueueIntent, { type: "queue/enqueued" }>
): EngineReducerResult<PromptQueueState> {
  const agentSessionId = intent.agentSessionId.trim();
  const workspaceId = intent.workspaceId.trim();
  const prompt = normalizeQueuedPrompt(intent.prompt);
  if (!agentSessionId || !workspaceId || !prompt) {
    return unchanged(state);
  }
  const current =
    state.recordsBySessionId[agentSessionId] ??
    emptyQueueRecord(
      workspaceId,
      agentSessionId,
      state.availabilityBySessionId[agentSessionId]
    );
  if (current.prompts.some((candidate) => candidate.id === prompt.id)) {
    return unchanged(state);
  }
  const record = {
    ...current,
    prompts: [...current.prompts, prompt]
  };
  return startEligibleCommand(
    replaceRecord(state, agentSessionId, record),
    record
  );
}

function enqueueSubmit(
  state: PromptQueueState,
  intent: Extract<EngineIntent, { type: "submit/requested" }>
): EngineReducerResult<PromptQueueState> {
  if (intent.routing === "immediate") {
    return {
      commands: [
        {
          agentSessionId: intent.agentSessionId,
          commandId: `submit:send:${intent.clientSubmitId}`,
          clientSubmitId: intent.clientSubmitId,
          correlationId: intent.clientSubmitId,
          content: intent.runtimeContent ?? intent.content,
          ...(intent.displayPrompt
            ? { displayPrompt: intent.displayPrompt }
            : {}),
          ...(intent.guidance === true ? { guidance: true } : {}),
          ...(intent.submitDiagnostics
            ? { submitDiagnostics: intent.submitDiagnostics }
            : {}),
          promptId: intent.clientSubmitId,
          timeoutMs: QUEUE_SEND_TIMEOUT_MS,
          type: "queue/sendPrompt",
          workspaceId: intent.workspaceId
        }
      ],
      state
    };
  }
  const current = state.recordsBySessionId[intent.agentSessionId.trim()];
  const availability =
    current?.availability ??
    state.availabilityBySessionId[intent.agentSessionId.trim()];
  const visibleInQueue = Boolean(
    current?.prompts.length ||
    current?.inFlight ||
    availability?.state !== "available"
  );
  const resumed = resumeQueue(state, intent.agentSessionId).state;
  return enqueuePrompt(resumed, {
    agentSessionId: intent.agentSessionId,
    prompt: {
      clientSubmitId: intent.clientSubmitId,
      content: intent.content,
      createdAtUnixMs: intent.requestedAtUnixMs,
      ...(intent.displayPrompt ? { displayPrompt: intent.displayPrompt } : {}),
      ...(intent.guidance === true ? { guidance: true } : {}),
      id: intent.clientSubmitId,
      submitDiagnostics: {
        ...(intent.submitDiagnostics ?? {}),
        blockCount:
          intent.submitDiagnostics?.blockCount ?? intent.content.length,
        queued: visibleInQueue,
        submittedAtUnixMs:
          intent.submitDiagnostics?.submittedAtUnixMs ??
          intent.requestedAtUnixMs
      },
      ...(intent.runtimeContent
        ? { runtimeContent: intent.runtimeContent }
        : {}),
      visibleInQueue
    },
    type: "queue/enqueued",
    workspaceId: intent.workspaceId
  });
}

function removePrompt(
  state: PromptQueueState,
  rawAgentSessionId: string,
  rawPromptId: string
): EngineReducerResult<PromptQueueState> {
  const agentSessionId = rawAgentSessionId.trim();
  const promptId = rawPromptId.trim();
  const current = state.recordsBySessionId[agentSessionId];
  if (
    !current ||
    !promptId ||
    current.inFlight?.promptId === promptId ||
    current.uncertainDelivery?.promptId === promptId ||
    !current.prompts.some((prompt) => prompt.id === promptId)
  ) {
    return unchanged(state);
  }
  const next = compactRecord({
    ...current,
    failedPromptId:
      current.failedPromptId === promptId ? null : current.failedPromptId,
    failureMessage:
      current.failedPromptId === promptId ? null : current.failureMessage,
    prompts: current.prompts.filter((prompt) => prompt.id !== promptId),
    sendNextPromptId:
      current.sendNextPromptId === promptId ? null : current.sendNextPromptId
  });
  return {
    commands: NO_COMMANDS,
    state: next
      ? replaceRecord(state, agentSessionId, next)
      : deleteRecord(state, agentSessionId)
  };
}

function promotePrompt(
  state: PromptQueueState,
  rawAgentSessionId: string,
  rawPromptId: string
): EngineReducerResult<PromptQueueState> {
  const agentSessionId = rawAgentSessionId.trim();
  const promptId = rawPromptId.trim();
  if (!canPromoteQueuedPrompt(state, agentSessionId, promptId)) {
    return unchanged(state);
  }
  const current = state.recordsBySessionId[agentSessionId]!;
  const index = current.prompts.findIndex((prompt) => prompt.id === promptId);
  if (index < 0) {
    return unchanged(state);
  }
  const prompts = [...current.prompts];
  const [selected] = prompts.splice(index, 1);
  prompts.unshift(selected!);
  const record: PromptQueueRecord = {
    ...current,
    failedPromptId:
      current.failedPromptId === promptId ? null : current.failedPromptId,
    failureMessage:
      current.failedPromptId === promptId ? null : current.failureMessage,
    prompts,
    sendNextPromptId: promptId,
    suspendReason: null
  };
  const nextState = replaceRecord(state, agentSessionId, record);
  return startEligibleCommand(nextState, record);
}

function suspendQueue(
  state: PromptQueueState,
  rawAgentSessionId: string,
  reason: PromptQueueRecord["suspendReason"]
): EngineReducerResult<PromptQueueState> {
  const agentSessionId = rawAgentSessionId.trim();
  const current = state.recordsBySessionId[agentSessionId];
  if (
    !current ||
    current.prompts.length === 0 ||
    current.suspendReason === reason
  ) {
    return unchanged(state);
  }
  return {
    commands: NO_COMMANDS,
    state: replaceRecord(state, agentSessionId, {
      ...current,
      suspendReason: reason
    })
  };
}

function resumeQueue(
  state: PromptQueueState,
  rawAgentSessionId: string
): EngineReducerResult<PromptQueueState> {
  const agentSessionId = rawAgentSessionId.trim();
  const current = state.recordsBySessionId[agentSessionId];
  if (!current || current.suspendReason === null) {
    return unchanged(state);
  }
  const record = { ...current, suspendReason: null };
  return startEligibleCommand(
    replaceRecord(state, agentSessionId, record),
    record
  );
}

function settleQueueCommand(
  state: PromptQueueState,
  intent: EngineCommandResultIntent
): EngineReducerResult<PromptQueueState> {
  const entry = Object.entries(state.recordsBySessionId).find(
    ([, record]) => record.inFlight?.commandId === intent.commandId
  );
  if (!entry) {
    return unchanged(state);
  }
  const [agentSessionId, current] = entry;
  const inFlight = current.inFlight!;
  if (intent.outcome === "succeeded") {
    const record = compactRecord({
      ...current,
      failedPromptId: null,
      failureMessage: null,
      inFlight: null,
      prompts: current.prompts.filter(
        (prompt) => prompt.id !== inFlight.promptId
      ),
      sendNextPromptId:
        current.sendNextPromptId === inFlight.promptId
          ? null
          : current.sendNextPromptId
    });
    if (!record) {
      return {
        commands: NO_COMMANDS,
        state: deleteRecord(state, agentSessionId)
      };
    }
    const nextState = replaceRecord(state, agentSessionId, record);
    const observedLifecycleAdvance = observedSettledTurnAfterQueueSend(
      record.availability,
      inFlight
    );
    return observedLifecycleAdvance
      ? startEligibleCommand(nextState, record)
      : { commands: NO_COMMANDS, state: nextState };
  }
  if (intent.outcome === "timedOut") {
    const uncertain = {
      ...current,
      failedPromptId: inFlight.promptId,
      failureMessage: null,
      inFlight: null,
      uncertainDelivery: inFlight
    };
    const compacted = compactRecord(uncertain);
    if (!compacted) {
      return {
        commands: NO_COMMANDS,
        state: deleteRecord(state, agentSessionId)
      };
    }
    const nextState = replaceRecord(state, agentSessionId, compacted);
    return {
      commands: [
        {
          agentSessionId,
          commandId: `queue:reconcile:${intent.commandId}`,
          scope: "state_and_messages",
          timeoutMs: 30_000,
          type: "session/reconcile",
          workspaceId: current.workspaceId
        }
      ],
      state: nextState
    };
  }
  const record: PromptQueueRecord = {
    ...current,
    failedPromptId: inFlight.promptId,
    failureMessage: intent.errorMessage?.trim() || null,
    inFlight: null
  };
  return {
    commands: NO_COMMANDS,
    state: replaceRecord(state, agentSessionId, record)
  };
}

function receiveTurnCancelResult(
  state: PromptQueueState,
  intent: EngineCommandResultIntent,
  validation: CancelResultValidation | null
): EngineReducerResult<PromptQueueState> {
  if (
    intent.outcome !== "succeeded" ||
    validation?.kind !== "valid" ||
    !validation.response.turn
  ) {
    return unchanged(state);
  }
  const turn = validation.response.turn;
  let nextState = state;
  const commands: EngineCommand[] = [];
  for (const [agentSessionId, current] of Object.entries(
    state.recordsBySessionId
  )) {
    if (
      current.sendNextPromptId !== current.prompts[0]?.id ||
      current.availability.activeTurnId !== turn.turnId ||
      turn.agentSessionId !== agentSessionId
    ) {
      continue;
    }
    const availability: PromptQueueRecord["availability"] = {
      activeTurnId: turn.phase === "settled" ? null : turn.turnId,
      lastTurnId: turn.turnId,
      lastTurnVersion: turn.updatedAtUnixMs,
      sessionVersion: turn.updatedAtUnixMs,
      state: turn.phase === "settled" ? "available" : "blocked"
    };
    if (
      !shouldAcceptPromptQueueAvailability(current.availability, availability)
    ) {
      continue;
    }
    const record = { ...current, availability };
    nextState = replaceRecord(
      {
        ...nextState,
        availabilityBySessionId: {
          ...nextState.availabilityBySessionId,
          [agentSessionId]: availability
        }
      },
      agentSessionId,
      record
    );
    const started = startEligibleCommand(nextState, record);
    nextState = started.state;
    commands.push(...started.commands);
  }
  return nextState === state && commands.length === 0
    ? unchanged(state)
    : { commands, state: nextState };
}

export function canPromoteQueuedPrompt(
  state: PromptQueueState,
  rawAgentSessionId: string,
  rawPromptId: string
): boolean {
  const agentSessionId = rawAgentSessionId.trim();
  const promptId = rawPromptId.trim();
  const current = state.recordsBySessionId[agentSessionId];
  return Boolean(
    current &&
    promptId &&
    current.inFlight?.promptId !== promptId &&
    current.uncertainDelivery?.promptId !== promptId &&
    current.prompts.some((prompt) => prompt.id === promptId)
  );
}

function startEligibleCommand(
  state: PromptQueueState,
  record: PromptQueueRecord
): EngineReducerResult<PromptQueueState> {
  const head = record.prompts[0];
  if (
    !head ||
    record.inFlight ||
    record.uncertainDelivery ||
    record.suspendReason ||
    record.failedPromptId === head.id
  ) {
    return { commands: NO_COMMANDS, state };
  }
  const sequence = state.nextCommandSequence;
  if (record.availability.state !== "available") {
    return { commands: NO_COMMANDS, state };
  }
  const commandId = queueCommandId("send", record.agentSessionId, sequence);
  return {
    commands: [
      {
        agentSessionId: record.agentSessionId,
        commandId,
        ...(head.clientSubmitId ? { correlationId: head.clientSubmitId } : {}),
        clientSubmitId: head.clientSubmitId ?? head.id,
        content: head.runtimeContent ?? head.content,
        ...(head.displayPrompt ? { displayPrompt: head.displayPrompt } : {}),
        ...(head.guidance === true ? { guidance: true } : {}),
        ...(head.submitDiagnostics
          ? { submitDiagnostics: head.submitDiagnostics }
          : {}),
        promptId: head.id,
        timeoutMs: QUEUE_SEND_TIMEOUT_MS,
        type: "queue/sendPrompt",
        workspaceId: record.workspaceId
      }
    ],
    state: replaceRecord(
      { ...state, nextCommandSequence: sequence + 1 },
      record.agentSessionId,
      {
        ...record,
        inFlight: {
          commandId,
          kind: "send",
          promptId: head.id,
          startedLastTurnId: record.availability.lastTurnId,
          startedLastTurnVersion: record.availability.lastTurnVersion
        }
      }
    )
  };
}

function emptyQueueRecord(
  workspaceId: string,
  agentSessionId: string,
  availability?: PromptQueueRecord["availability"]
): PromptQueueRecord {
  return {
    agentSessionId,
    availability: availability ?? {
      activeTurnId: null,
      lastTurnId: null,
      lastTurnVersion: null,
      sessionVersion: null,
      state: "missing"
    },
    failedPromptId: null,
    failureMessage: null,
    inFlight: null,
    prompts: [],
    sendNextPromptId: null,
    suspendReason: null,
    uncertainDelivery: null,
    workspaceId
  };
}

function compactRecord(record: PromptQueueRecord): PromptQueueRecord | null {
  return record.prompts.length === 0 &&
    !record.inFlight &&
    !record.uncertainDelivery
    ? null
    : record;
}

function removeQueue(
  state: PromptQueueState,
  rawAgentSessionId: string
): EngineReducerResult<PromptQueueState> {
  const agentSessionId = rawAgentSessionId.trim();
  if (!state.recordsBySessionId[agentSessionId]) {
    return unchanged(state);
  }
  return { commands: NO_COMMANDS, state: deleteRecord(state, agentSessionId) };
}

function removeSession(
  state: PromptQueueState,
  rawAgentSessionId: string
): EngineReducerResult<PromptQueueState> {
  const agentSessionId = rawAgentSessionId.trim();
  const hasQueue = Boolean(state.recordsBySessionId[agentSessionId]);
  const hasAvailability = Boolean(
    state.availabilityBySessionId[agentSessionId]
  );
  if (!hasQueue && !hasAvailability) {
    return unchanged(state);
  }
  const availabilityBySessionId = { ...state.availabilityBySessionId };
  delete availabilityBySessionId[agentSessionId];
  const withoutAvailability = { ...state, availabilityBySessionId };
  return {
    commands: NO_COMMANDS,
    state: hasQueue
      ? deleteRecord(withoutAvailability, agentSessionId)
      : withoutAvailability
  };
}

function replaceRecord(
  state: PromptQueueState,
  agentSessionId: string,
  record: PromptQueueRecord
): PromptQueueState {
  return {
    ...state,
    recordsBySessionId: {
      ...state.recordsBySessionId,
      [agentSessionId]: record
    }
  };
}

function deleteRecord(
  state: PromptQueueState,
  agentSessionId: string
): PromptQueueState {
  const records = { ...state.recordsBySessionId };
  delete records[agentSessionId];
  return { ...state, recordsBySessionId: records };
}

function queueCommandId(
  kind: "send",
  agentSessionId: string,
  sequence: number
): string {
  return `queue:${kind}:${agentSessionId}:${sequence}`;
}

function confirmDeliveredPrompts(
  state: PromptQueueState,
  messages: readonly AgentActivityMessage[]
): EngineReducerResult<PromptQueueState> {
  const confirmed = new Set(
    messages
      .map((message) => message.payload?.clientSubmitId)
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      )
      .map((value) => value.trim())
  );
  if (confirmed.size === 0) {
    return unchanged(state);
  }
  let next = state;
  const commands: EngineCommand[] = [];
  for (const [agentSessionId, current] of Object.entries(
    state.recordsBySessionId
  )) {
    const matchedIds = current.prompts
      .filter(
        (prompt) =>
          prompt.clientSubmitId && confirmed.has(prompt.clientSubmitId)
      )
      .map((prompt) => prompt.id);
    if (matchedIds.length === 0) {
      continue;
    }
    const matched = new Set(matchedIds);
    const record = compactRecord({
      ...current,
      failedPromptId: matched.has(current.failedPromptId ?? "")
        ? null
        : current.failedPromptId,
      failureMessage: matched.has(current.failedPromptId ?? "")
        ? null
        : current.failureMessage,
      prompts: current.prompts.filter((prompt) => !matched.has(prompt.id)),
      uncertainDelivery:
        current.uncertainDelivery &&
        matched.has(current.uncertainDelivery.promptId)
          ? null
          : current.uncertainDelivery
    });
    next = record
      ? replaceRecord(next, agentSessionId, record)
      : deleteRecord(next, agentSessionId);
    if (record) {
      const started = startEligibleCommand(next, record);
      next = started.state;
      commands.push(...started.commands);
    }
  }
  return next === state ? unchanged(state) : { commands, state: next };
}

function expireUncertainDelivery(
  state: PromptQueueState,
  expiryId: string
): EngineReducerResult<PromptQueueState> {
  if (!expiryId.startsWith("submit:")) {
    return unchanged(state);
  }
  const clientSubmitId = expiryId.slice("submit:".length);
  const entry = Object.entries(state.recordsBySessionId).find(([, record]) => {
    const promptId = record.uncertainDelivery?.promptId;
    return record.prompts.some(
      (prompt) =>
        prompt.id === promptId && prompt.clientSubmitId === clientSubmitId
    );
  });
  if (!entry) {
    return unchanged(state);
  }
  const [agentSessionId, record] = entry;
  return {
    commands: NO_COMMANDS,
    state: replaceRecord(state, agentSessionId, {
      ...record,
      failureMessage: null,
      uncertainDelivery: null
    })
  };
}

function unchanged(
  state: PromptQueueState
): EngineReducerResult<PromptQueueState> {
  return { commands: NO_COMMANDS, state };
}
