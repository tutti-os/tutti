import type { AgentActivityMessage } from "../types.ts";
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
import type {
  CancelResultValidation,
  SendInputResultValidation,
  ScopedSessionResultValidation
} from "./commandResult.validation.ts";
import { promptQueuePromptIdForClientSubmit } from "./promptQueue.lookup.ts";
import {
  clonePromptRequiredSettingsPatch,
  normalizeQueuedPrompt
} from "./promptQueue.prompt.ts";
import {
  compactQueueRecord,
  emptyQueueRecord,
  queueSendCommandId
} from "./promptQueue.record.ts";
import {
  canRequestQueuedPromptSendNow,
  type PromptQueueSendNowStrategy
} from "./promptQueue.sendNow.ts";
import { resolveQueueDrainDecision } from "./promptQueue.drainDecision.ts";
import {
  deriveCanonicalSubmitAvailability,
  type CanonicalSessionLifecycleView
} from "./sessionLifecycle.availability.ts";
import { canonicalTurnKey } from "./sessionEntityKeys.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];
const QUEUE_SEND_TIMEOUT_MS = 30_000;

export { createInitialPromptQueueState } from "./promptQueue.initialState.ts";

export interface PromptQueueReducerContext {
  lifecycle: CanonicalSessionLifecycleView;
  deletedSessionIds: Readonly<Record<string, true>>;
  planFeedbackAccepted?: boolean;
  submitRequestAccepted?: boolean;
  cancelResultValidation?: CancelResultValidation | null;
  interactionResultValidation?: ScopedSessionResultValidation | null;
  sendResultValidation?: SendInputResultValidation | null;
  sendNowStrategy?: PromptQueueSendNowStrategy | null;
  settingsResultValidation?: ScopedSessionResultValidation | null;
}

export function promptQueueReducer(
  state: PromptQueueState,
  intent: EngineIntent,
  context: PromptQueueReducerContext
): EngineReducerResult<PromptQueueState> {
  const reduced = reduceQueueOwnedState(state, intent, context);
  if (intent.type === "submit/requested" && intent.routing === "immediate") {
    return reduced;
  }
  if (isNoActiveTurnSendFailure(intent)) {
    return reduced;
  }
  return drainAffectedSessions(
    reduced,
    affectedSessionIds(state, intent, context),
    context.lifecycle
  );
}

function reduceQueueOwnedState(
  state: PromptQueueState,
  intent: EngineIntent,
  context: PromptQueueReducerContext
): EngineReducerResult<PromptQueueState> {
  switch (intent.type) {
    case "session/removed":
    case "queue/sessionCleaned":
      return removeQueue(state, intent.agentSessionId);
    case "queue/enqueued":
      return context.deletedSessionIds[intent.agentSessionId.trim()]
        ? unchanged(state)
        : enqueuePrompt(state, intent);
    case "submit/requested":
      if (
        context.submitRequestAccepted === false ||
        context.deletedSessionIds[intent.agentSessionId.trim()]
      ) {
        return unchanged(state);
      }
      if (intent.routing === "send_now") {
        if (!context.sendNowStrategy) return unchanged(state);
        return requestQueuedPromptSendNow(
          enqueueSubmit(state, intent, context.lifecycle).state,
          intent.agentSessionId,
          intent.clientSubmitId,
          context.sendNowStrategy
        );
      }
      return enqueueSubmit(state, intent, context.lifecycle);
    case "plan/feedbackRequested":
      return context.planFeedbackAccepted === true
        ? enqueueSubmit(
            state,
            { ...intent, type: "submit/requested" },
            context.lifecycle
          )
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
    case "queue/removed":
      return removePrompt(state, intent.agentSessionId, intent.promptId);
    case "queue/sendNowRequested":
      if (
        context.deletedSessionIds[intent.agentSessionId.trim()] ||
        !context.sendNowStrategy
      ) {
        return unchanged(state);
      }
      return requestQueuedPromptSendNow(
        state,
        intent.agentSessionId,
        intent.promptId,
        context.sendNowStrategy
      );
    case "queue/suspended":
      return suspendQueue(state, intent.agentSessionId, intent.reason);
    case "session/stopRequested":
      return suspendQueue(state, intent.agentSessionId, "user_stop");
    case "queue/resumed":
      return context.deletedSessionIds[intent.agentSessionId.trim()]
        ? unchanged(state)
        : resumeQueue(state, intent.agentSessionId);
    case "engine/commandResult":
      return intent.commandType === "queue/sendPrompt"
        ? settleQueueCommand(
            state,
            intent,
            context.sendResultValidation ?? null
          )
        : unchanged(state);
    default:
      return unchanged(state);
  }
}

function enqueuePrompt(
  state: PromptQueueState,
  intent: Extract<PromptQueueIntent, { type: "queue/enqueued" }>,
  options?: { insertAtFront?: boolean }
): EngineReducerResult<PromptQueueState> {
  const agentSessionId = intent.agentSessionId.trim();
  const workspaceId = intent.workspaceId.trim();
  const prompt = normalizeQueuedPrompt(intent.prompt);
  if (!agentSessionId || !workspaceId || !prompt) return unchanged(state);
  const current =
    state.recordsBySessionId[agentSessionId] ??
    emptyQueueRecord(workspaceId, agentSessionId);
  if (current.prompts.some((candidate) => candidate.id === prompt.id)) {
    return unchanged(state);
  }
  return result(
    replaceRecord(state, agentSessionId, {
      ...current,
      prompts: options?.insertAtFront
        ? [prompt, ...current.prompts]
        : [...current.prompts, prompt]
    })
  );
}

function enqueueSubmit(
  state: PromptQueueState,
  intent: Extract<EngineIntent, { type: "submit/requested" }>,
  lifecycle: CanonicalSessionLifecycleView
): EngineReducerResult<PromptQueueState> {
  if (intent.routing === "immediate") {
    return {
      commands: [sendCommandFromImmediateSubmit(intent)],
      state
    };
  }
  const agentSessionId = intent.agentSessionId.trim();
  const current = state.recordsBySessionId[agentSessionId];
  const availability = deriveCanonicalSubmitAvailability(
    lifecycle,
    agentSessionId
  );
  const visibleInQueue = Boolean(
    current?.prompts.length ||
    current?.inFlight ||
    current?.uncertainDelivery ||
    current?.deliveryBarrierTurnId ||
    availability.state !== "available"
  );
  // An ordinary submit that resumes a queue the user just explicitly
  // stopped is the user's next instruction, not a continuation of whatever
  // was already queued before the stop: it jumps ahead of that stale
  // backlog instead of preserving FIFO order behind it.
  const resumingFromUserStop = current?.suspendReason === "user_stop";
  const resumed = resumeQueue(state, agentSessionId);
  return enqueuePrompt(
    resumed.state,
    {
      agentSessionId,
      prompt: {
        clientSubmitId: intent.clientSubmitId,
        content: intent.content,
        createdAtUnixMs: intent.requestedAtUnixMs,
        ...(intent.displayPrompt
          ? { displayPrompt: intent.displayPrompt }
          : {}),
        id: intent.clientSubmitId,
        ...clonePromptRequiredSettingsPatch(intent.requiredSettingsPatch),
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
    },
    { insertAtFront: resumingFromUserStop }
  );
}

function sendCommandFromImmediateSubmit(
  intent: Extract<EngineIntent, { type: "submit/requested" }>
): Extract<EngineCommand, { type: "queue/sendPrompt" }> {
  return {
    agentSessionId: intent.agentSessionId,
    commandId: `submit:send:${intent.clientSubmitId}`,
    clientSubmitId: intent.clientSubmitId,
    correlationId: intent.clientSubmitId,
    content: intent.runtimeContent ?? intent.content,
    ...(intent.displayPrompt ? { displayPrompt: intent.displayPrompt } : {}),
    ...(intent.submitDiagnostics
      ? { submitDiagnostics: intent.submitDiagnostics }
      : {}),
    promptId: intent.clientSubmitId,
    ...clonePromptRequiredSettingsPatch(intent.requiredSettingsPatch),
    timeoutMs: QUEUE_SEND_TIMEOUT_MS,
    type: "queue/sendPrompt",
    workspaceId: intent.workspaceId
  };
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
  const next = compactQueueRecord({
    ...current,
    failedPromptId:
      current.failedPromptId === promptId ? null : current.failedPromptId,
    failureMessage:
      current.failedPromptId === promptId ? null : current.failureMessage,
    prompts: current.prompts.filter((prompt) => prompt.id !== promptId),
    sendNextPromptId:
      current.sendNextPromptId === promptId ? null : current.sendNextPromptId
  });
  return result(
    next
      ? replaceRecord(state, agentSessionId, next)
      : deleteRecord(state, agentSessionId)
  );
}

function requestQueuedPromptSendNow(
  state: PromptQueueState,
  rawAgentSessionId: string,
  rawPromptId: string,
  strategy: PromptQueueSendNowStrategy
): EngineReducerResult<PromptQueueState> {
  const agentSessionId = rawAgentSessionId.trim();
  const promptId = rawPromptId.trim();
  if (!canRequestQueuedPromptSendNow(state, agentSessionId, promptId)) {
    return unchanged(state);
  }
  const current = state.recordsBySessionId[agentSessionId]!;
  const index = current.prompts.findIndex((prompt) => prompt.id === promptId);
  if (index < 0) return unchanged(state);
  const prompts = [...current.prompts];
  const [selected] = prompts.splice(index, 1);
  const selectedWithoutGuidance = { ...selected! };
  delete selectedWithoutGuidance.guidance;
  prompts.unshift(
    strategy === "native_guidance"
      ? { ...selectedWithoutGuidance, guidance: true }
      : selectedWithoutGuidance
  );
  return result(
    replaceRecord(state, agentSessionId, {
      ...current,
      failedPromptId:
        current.failedPromptId === promptId ? null : current.failedPromptId,
      failureMessage:
        current.failedPromptId === promptId ? null : current.failureMessage,
      prompts,
      sendNextPromptId: strategy === "cancel_then_send" ? promptId : null,
      suspendReason: null
    })
  );
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
  return result(
    replaceRecord(state, agentSessionId, { ...current, suspendReason: reason })
  );
}

function resumeQueue(
  state: PromptQueueState,
  rawAgentSessionId: string
): EngineReducerResult<PromptQueueState> {
  const agentSessionId = rawAgentSessionId.trim();
  const current = state.recordsBySessionId[agentSessionId];
  return !current || current.suspendReason === null
    ? unchanged(state)
    : result(
        replaceRecord(state, agentSessionId, {
          ...current,
          suspendReason: null
        })
      );
}

function settleQueueCommand(
  state: PromptQueueState,
  intent: EngineCommandResultIntent,
  validation: SendInputResultValidation | null
): EngineReducerResult<PromptQueueState> {
  const entry = Object.entries(state.recordsBySessionId).find(
    ([, record]) => record.inFlight?.commandId === intent.commandId
  );
  if (!entry) return unchanged(state);
  const [agentSessionId, current] = entry;
  const inFlight = current.inFlight!;
  if (intent.outcome === "succeeded" && validation?.kind === "valid") {
    const deliveryBarrierTurnId =
      validation.result.kind === "goalControl"
        ? null
        : validation.result.turnId;
    const record = compactQueueRecord({
      ...current,
      deliveryBarrierTurnId,
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
    return result(
      record
        ? replaceRecord(state, agentSessionId, record)
        : deleteRecord(state, agentSessionId)
    );
  }
  if (intent.outcome === "timedOut" || intent.outcome === "succeeded") {
    const record = {
      ...current,
      failedPromptId: inFlight.promptId,
      failureMessage: null,
      inFlight: null,
      uncertainDelivery: inFlight
    };
    return {
      commands: [reconcileCommand(agentSessionId, current.workspaceId, intent)],
      state: replaceRecord(state, agentSessionId, record)
    };
  }
  if (isNoActiveTurnSendFailure(intent)) {
    return {
      commands: [reconcileCommand(agentSessionId, current.workspaceId, intent)],
      state: replaceRecord(state, agentSessionId, {
        ...current,
        failedPromptId: null,
        failureMessage: null,
        inFlight: null
      })
    };
  }
  return result(
    replaceRecord(state, agentSessionId, {
      ...current,
      failedPromptId: inFlight.promptId,
      failureMessage: intent.errorMessage?.trim() || null,
      inFlight: null
    })
  );
}

function reconcileCommand(
  agentSessionId: string,
  workspaceId: string,
  intent: EngineCommandResultIntent
): Extract<EngineCommand, { type: "session/reconcile" }> {
  return {
    agentSessionId,
    commandId: `queue:reconcile:${intent.commandId}`,
    scope: "state_and_messages",
    timeoutMs: 30_000,
    type: "session/reconcile",
    workspaceId
  };
}

function isNoActiveTurnSendFailure(intent: EngineIntent): boolean {
  return (
    intent.type === "engine/commandResult" &&
    intent.commandType === "queue/sendPrompt" &&
    intent.outcome === "failed" &&
    (intent.errorReason?.trim() === "agent.no_active_turn" ||
      intent.errorCode?.trim() === "agent.no_active_turn")
  );
}

function confirmDeliveredPrompts(
  state: PromptQueueState,
  messages: readonly AgentActivityMessage[]
): EngineReducerResult<PromptQueueState> {
  const confirmedTurnByClientSubmitId = exactConfirmedTurns(messages);
  if (confirmedTurnByClientSubmitId.size === 0) return unchanged(state);
  let next = state;
  for (const [agentSessionId, current] of Object.entries(
    state.recordsBySessionId
  )) {
    const matched = current.prompts.find((prompt) => {
      const turnId = prompt.clientSubmitId
        ? confirmedTurnByClientSubmitId.get(prompt.clientSubmitId)
        : undefined;
      return Boolean(turnId);
    });
    if (!matched?.clientSubmitId) continue;
    const turnId = confirmedTurnByClientSubmitId.get(matched.clientSubmitId);
    if (!turnId) continue;
    const record = compactQueueRecord({
      ...current,
      deliveryBarrierTurnId: turnId,
      failedPromptId:
        current.failedPromptId === matched.id ? null : current.failedPromptId,
      failureMessage:
        current.failedPromptId === matched.id ? null : current.failureMessage,
      inFlight:
        current.inFlight?.promptId === matched.id ? null : current.inFlight,
      prompts: current.prompts.filter((prompt) => prompt.id !== matched.id),
      sendNextPromptId:
        current.sendNextPromptId === matched.id
          ? null
          : current.sendNextPromptId,
      uncertainDelivery:
        current.uncertainDelivery?.promptId === matched.id
          ? null
          : current.uncertainDelivery
    });
    next = record
      ? replaceRecord(next, agentSessionId, record)
      : deleteRecord(next, agentSessionId);
  }
  return next === state ? unchanged(state) : result(next);
}

function exactConfirmedTurns(
  messages: readonly AgentActivityMessage[]
): ReadonlyMap<string, string> {
  const turnsBySubmitId = new Map<string, Set<string>>();
  for (const message of messages) {
    const clientSubmitId = message.payload?.clientSubmitId;
    const turnId = message.turnId?.trim() ?? "";
    if (
      typeof clientSubmitId !== "string" ||
      !clientSubmitId.trim() ||
      !turnId
    ) {
      continue;
    }
    const id = clientSubmitId.trim();
    const turns = turnsBySubmitId.get(id) ?? new Set<string>();
    turns.add(turnId);
    turnsBySubmitId.set(id, turns);
  }
  return new Map(
    [...turnsBySubmitId]
      .filter(([, turns]) => turns.size === 1)
      .map(([clientSubmitId, turns]) => [clientSubmitId, [...turns][0]!])
  );
}

function drainAffectedSessions(
  reduced: EngineReducerResult<PromptQueueState>,
  affected: readonly string[],
  lifecycle: CanonicalSessionLifecycleView
): EngineReducerResult<PromptQueueState> {
  let state = reduced.state;
  const commands = [...reduced.commands];
  for (const agentSessionId of [...new Set(affected)].sort()) {
    const drained = drainSession(state, agentSessionId, lifecycle);
    state = drained.state;
    commands.push(...drained.commands);
  }
  return state === reduced.state && commands.length === reduced.commands.length
    ? reduced
    : { commands, state };
}

function drainSession(
  state: PromptQueueState,
  agentSessionId: string,
  lifecycle: CanonicalSessionLifecycleView
): EngineReducerResult<PromptQueueState> {
  const originalState = state;
  let record = state.recordsBySessionId[agentSessionId];
  if (!record) return unchanged(state);
  let barrierPending = false;
  if (record.deliveryBarrierTurnId) {
    const barrierTurn =
      lifecycle.turnsById[
        canonicalTurnKey(agentSessionId, record.deliveryBarrierTurnId)
      ];
    if (!barrierTurn || barrierTurn.phase !== "settled") {
      // The barrier only serializes plain new-turn sends; it does not gate
      // drain readiness on its own. Whether it blocks the head is decided
      // below, alongside every other blocker, so a guidance head steering
      // this very turn is not deadlocked behind its own barrier.
      barrierPending = true;
    } else {
      record = { ...record, deliveryBarrierTurnId: null };
      const compacted = compactQueueRecord(record);
      state = compacted
        ? replaceRecord(state, agentSessionId, compacted)
        : deleteRecord(state, agentSessionId);
      if (!compacted) return result(state);
    }
  }
  const availability = deriveCanonicalSubmitAvailability(
    lifecycle,
    agentSessionId
  );
  // The guidance flag was resolved when the prompt entered the queue; whether
  // it can steer is decided here, against the availability observed at drain
  // time. A prompt queued as guidance behind a turn that has since settled is
  // sent as a plain new-turn submit instead of a doomed steer.
  const decision = resolveQueueDrainDecision(
    record,
    availability,
    barrierPending
  );
  if (decision.kind === "blocked") {
    return state === originalState ? unchanged(state) : result(state);
  }
  const head = record.prompts[0]!;
  const sequence = state.nextCommandSequence;
  const commandId = queueSendCommandId(record.agentSessionId, sequence);
  return {
    commands: [
      sendCommandFromQueuedPrompt(record, head, commandId, decision.guidance)
    ],
    state: replaceRecord(
      { ...state, nextCommandSequence: sequence + 1 },
      record.agentSessionId,
      {
        ...record,
        inFlight: {
          commandId,
          ...(decision.guidance ? { guidance: true as const } : {}),
          kind: "send",
          promptId: head.id
        }
      }
    )
  };
}

function sendCommandFromQueuedPrompt(
  record: PromptQueueRecord,
  head: PromptQueueRecord["prompts"][number],
  commandId: string,
  guidance: boolean
): Extract<EngineCommand, { type: "queue/sendPrompt" }> {
  return {
    agentSessionId: record.agentSessionId,
    commandId,
    ...(head.clientSubmitId ? { correlationId: head.clientSubmitId } : {}),
    clientSubmitId: head.clientSubmitId ?? head.id,
    content: head.runtimeContent ?? head.content,
    ...(head.displayPrompt ? { displayPrompt: head.displayPrompt } : {}),
    ...(guidance ? { guidance: true } : {}),
    ...(head.submitDiagnostics
      ? { submitDiagnostics: head.submitDiagnostics }
      : {}),
    promptId: head.id,
    ...clonePromptRequiredSettingsPatch(head.requiredSettingsPatch),
    timeoutMs: QUEUE_SEND_TIMEOUT_MS,
    type: "queue/sendPrompt",
    workspaceId: record.workspaceId
  };
}

function affectedSessionIds(
  state: PromptQueueState,
  intent: EngineIntent,
  context: PromptQueueReducerContext
): string[] {
  const ids: string[] = [];
  if ("agentSessionId" in intent && typeof intent.agentSessionId === "string") {
    ids.push(intent.agentSessionId.trim());
  }
  if (intent.type === "session/snapshotReceived") {
    ids.push(
      ...intent.sessions.map((session) => session.agentSessionId.trim())
    );
  }
  if (intent.type === "session/upserted") {
    ids.push(intent.session.agentSessionId.trim());
  }
  if (intent.type === "turn/upserted") {
    ids.push(intent.turn.agentSessionId.trim());
  }
  if (intent.type === "interaction/upserted") {
    ids.push(intent.interaction.agentSessionId.trim());
  }
  if (intent.type === "message/snapshotReceived") {
    ids.push(
      ...intent.messages.map((message) => message.agentSessionId.trim())
    );
  }
  if (intent.type === "engine/commandResult") {
    const queueEntry = Object.entries(state.recordsBySessionId).find(
      ([, record]) => record.inFlight?.commandId === intent.commandId
    );
    if (queueEntry) ids.push(queueEntry[0]);
    const validatedSessionIds = [
      context.sendResultValidation?.kind === "valid"
        ? context.sendResultValidation.result.session.agentSessionId
        : undefined,
      context.interactionResultValidation?.kind === "valid"
        ? context.interactionResultValidation.session.agentSessionId
        : undefined,
      context.settingsResultValidation?.kind === "valid"
        ? context.settingsResultValidation.session.agentSessionId
        : undefined,
      context.cancelResultValidation?.kind === "valid"
        ? context.cancelResultValidation.response.turn?.agentSessionId
        : undefined
    ];
    ids.push(
      ...validatedSessionIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
    );
  }
  return ids.filter(Boolean);
}

function removeQueue(
  state: PromptQueueState,
  rawAgentSessionId: string
): EngineReducerResult<PromptQueueState> {
  const agentSessionId = rawAgentSessionId.trim();
  return state.recordsBySessionId[agentSessionId]
    ? result(deleteRecord(state, agentSessionId))
    : unchanged(state);
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

function result(
  state: PromptQueueState
): EngineReducerResult<PromptQueueState> {
  return { commands: NO_COMMANDS, state };
}

function unchanged(
  state: PromptQueueState
): EngineReducerResult<PromptQueueState> {
  return { commands: NO_COMMANDS, state };
}
