import { isPendingActivationViable } from "./pendingIntents.types.ts";
import type { PendingActivationIntentRecord } from "./pendingIntents.types.ts";
import {
  projectSessionGoalControl,
  sessionGoalsEqual
} from "./sessionGoalControl.projection.ts";
import type {
  SessionGoalControlOperation,
  SessionGoalControlPresentation,
  SessionGoalControlPublicState,
  SessionGoalControlSettlement
} from "./sessionGoalControl.types.ts";
import type {
  RootAgentSessionEngineState,
  RootEngineIntent
} from "./rootReducer.types.ts";
import type { AgentSessionEngineState } from "./types.ts";

export function selectInternalSessionGoalControlOperation(
  state: RootAgentSessionEngineState,
  agentSessionId: string | null | undefined
): SessionGoalControlOperation | null {
  const id = agentSessionId?.trim() ?? "";
  return state.goalControl.operationsBySessionId[id] ?? null;
}

export function selectSessionGoalControlSettlement(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): SessionGoalControlSettlement | null {
  const id = agentSessionId?.trim() ?? "";
  return state.goalControl.settlementsBySessionId[id] ?? null;
}

export function selectSessionGoalControlPresentation(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): SessionGoalControlPresentation {
  const id = agentSessionId?.trim() ?? "";
  return (
    state.goalControl.presentationsBySessionId[id] ?? {
      agentSessionId: id || null,
      goal: null,
      optimistic: false,
      status: "idle"
    }
  );
}

export function projectPublicSessionGoalControlState(
  state: RootAgentSessionEngineState,
  previous?: SessionGoalControlPublicState,
  previousRoot?: RootAgentSessionEngineState,
  cause?: RootEngineIntent
): SessionGoalControlPublicState {
  if (!previous || !previousRoot || !cause) {
    return projectAllPublicSessionGoalControlState(
      state,
      indexLatestGoalActivations(state)
    );
  }

  const changedOperationSessionIds = changedOperationIds(state, previousRoot);
  const presentationSessionIds = new Set(changedOperationSessionIds);
  addCanonicalGoalCandidates(
    presentationSessionIds,
    cause,
    state,
    previousRoot
  );
  addChangedActivationSessionIds(presentationSessionIds, state, previousRoot);
  if (presentationSessionIds.size === 0) return previous;
  const latestGoalActivations = indexLatestGoalActivations(state);

  let presentationsBySessionId: Record<string, SessionGoalControlPresentation> =
    previous.presentationsBySessionId;
  for (const agentSessionId of presentationSessionIds) {
    const activation = latestGoalActivations[agentSessionId] ?? null;
    const operation = state.goalControl.operationsBySessionId[agentSessionId];
    const canonicalGoal =
      state.sessionLifecycle.sessionsById[agentSessionId]?.goal ?? null;
    const relevant = Boolean(canonicalGoal || operation || activation);
    const previousPresentation = presentationsBySessionId[agentSessionId];
    if (!relevant) {
      if (previousPresentation) {
        if (presentationsBySessionId === previous.presentationsBySessionId) {
          presentationsBySessionId = { ...presentationsBySessionId };
        }
        delete presentationsBySessionId[agentSessionId];
      }
      continue;
    }
    const presentation = projectSessionGoalControlPresentation(
      state,
      agentSessionId,
      activation
    );
    if (
      previousPresentation &&
      sessionGoalControlPresentationsEqual(previousPresentation, presentation)
    ) {
      continue;
    }
    if (presentationsBySessionId === previous.presentationsBySessionId) {
      presentationsBySessionId = { ...presentationsBySessionId };
    }
    presentationsBySessionId[agentSessionId] = presentation;
  }

  let settlementsBySessionId: Record<string, SessionGoalControlSettlement> =
    previous.settlementsBySessionId;
  for (const agentSessionId of changedOperationSessionIds) {
    const operation = state.goalControl.operationsBySessionId[agentSessionId];
    const previousSettlement = settlementsBySessionId[agentSessionId];
    if (!operation) {
      if (previousSettlement) {
        if (settlementsBySessionId === previous.settlementsBySessionId) {
          settlementsBySessionId = { ...settlementsBySessionId };
        }
        delete settlementsBySessionId[agentSessionId];
      }
      continue;
    }
    const settlement = projectSessionGoalControlSettlement(operation);
    if (
      previousSettlement &&
      sessionGoalControlSettlementsEqual(previousSettlement, settlement)
    ) {
      continue;
    }
    if (settlementsBySessionId === previous.settlementsBySessionId) {
      settlementsBySessionId = { ...settlementsBySessionId };
    }
    settlementsBySessionId[agentSessionId] = settlement;
  }

  return presentationsBySessionId === previous.presentationsBySessionId &&
    settlementsBySessionId === previous.settlementsBySessionId
    ? previous
    : { presentationsBySessionId, settlementsBySessionId };
}

function projectSessionGoalControlPresentation(
  state: RootAgentSessionEngineState,
  id: string,
  activation: PendingActivationIntentRecord | null
): SessionGoalControlPresentation {
  const canonicalGoal = state.sessionLifecycle.sessionsById[id]?.goal ?? null;
  const operation = state.goalControl.operationsBySessionId[id] ?? null;
  if (
    operation &&
    (operation.status === "pending" ||
      operation.status === "accepted" ||
      operation.status === "unknown")
  ) {
    // A set/pause/resume control can stay accepted/applying (Claude
    // accepted_only) while the provider later observes a terminal Goal.
    // Prefer that canonical completion so the banner can hide; otherwise the
    // stale optimistic "active" Goal shadows it forever.
    if (
      operation.action === "set" &&
      isTerminalSessionGoalStatus(canonicalGoal?.status) &&
      !isTerminalSessionGoalStatus(operation.optimisticGoal?.status)
    ) {
      return {
        agentSessionId: id || null,
        goal: canonicalGoal,
        optimistic: false,
        status: operation.status
      };
    }
    return {
      agentSessionId: id || null,
      goal: operation.optimisticGoal,
      optimistic:
        operation.status === "pending" ||
        (operation.status === "unknown" && operation.resultState === null),
      status: operation.status
    };
  }
  // A succeeded clear stays authoritative until a later Goal operation
  // replaces it. Stale Session snapshots must not resurrect the banner.
  if (
    operation &&
    operation.status === "succeeded" &&
    operation.action === "clear"
  ) {
    return {
      agentSessionId: id || null,
      goal: null,
      optimistic: false,
      status: operation.status
    };
  }
  if (
    !operation &&
    activation?.mode === "new" &&
    activation.initialGoalControl &&
    isPendingActivationViable(activation)
  ) {
    const activationGoal = projectSessionGoalControl(
      canonicalGoal,
      activation.initialGoalControl.action,
      activation.initialGoalControl.objective
    );
    const canonicalSession =
      state.sessionLifecycle.sessionsById[activation.agentSessionId];
    const activationConfirmed = canonicalSession
      ? activationGoal === null
        ? canonicalGoal === null
        : canonicalGoal?.objective === activationGoal.objective
      : false;
    if (activationConfirmed) {
      return {
        agentSessionId: id || null,
        goal: canonicalGoal,
        optimistic: false,
        status: "idle"
      };
    }
    return {
      agentSessionId: id || null,
      goal: activationGoal,
      optimistic: true,
      status: "pending_create"
    };
  }
  return {
    agentSessionId: id || null,
    goal: canonicalGoal,
    optimistic: false,
    status: operation?.status ?? "idle"
  };
}

function projectAllPublicSessionGoalControlState(
  state: RootAgentSessionEngineState,
  latestGoalActivations: Readonly<Record<string, PendingActivationIntentRecord>>
): SessionGoalControlPublicState {
  const agentSessionIds = new Set([
    ...Object.entries(state.sessionLifecycle.sessionsById)
      .filter(([, session]) => session.goal)
      .map(([agentSessionId]) => agentSessionId),
    ...Object.keys(state.goalControl.operationsBySessionId),
    ...Object.keys(latestGoalActivations)
  ]);
  const presentationsBySessionId: Record<
    string,
    SessionGoalControlPresentation
  > = {};
  const settlementsBySessionId: Record<string, SessionGoalControlSettlement> =
    {};
  for (const agentSessionId of agentSessionIds) {
    presentationsBySessionId[agentSessionId] =
      projectSessionGoalControlPresentation(
        state,
        agentSessionId,
        latestGoalActivations[agentSessionId] ?? null
      );
  }
  for (const operation of Object.values(
    state.goalControl.operationsBySessionId
  )) {
    settlementsBySessionId[operation.agentSessionId] =
      projectSessionGoalControlSettlement(operation);
  }
  return { presentationsBySessionId, settlementsBySessionId };
}

function indexLatestGoalActivations(
  state: RootAgentSessionEngineState
): Record<string, PendingActivationIntentRecord> {
  const indexed: Record<string, PendingActivationIntentRecord> = {};
  for (const activation of Object.values(
    state.pendingIntents.activationsByRequestId
  )) {
    if (!activation.initialGoalControl) continue;
    const current = indexed[activation.agentSessionId];
    if (!current || activation.requestedAtUnixMs >= current.requestedAtUnixMs) {
      indexed[activation.agentSessionId] = activation;
    }
  }
  return indexed;
}

function changedOperationIds(
  state: RootAgentSessionEngineState,
  previousRoot: RootAgentSessionEngineState
): Set<string> {
  const current = state.goalControl.operationsBySessionId;
  const previous = previousRoot.goalControl.operationsBySessionId;
  if (current === previous) return new Set();
  const changed = new Set([...Object.keys(current), ...Object.keys(previous)]);
  for (const agentSessionId of changed) {
    if (current[agentSessionId] === previous[agentSessionId]) {
      changed.delete(agentSessionId);
    }
  }
  return changed;
}

function addChangedActivationSessionIds(
  target: Set<string>,
  state: RootAgentSessionEngineState,
  previousRoot: RootAgentSessionEngineState
): void {
  const current = state.pendingIntents.activationsByRequestId;
  const previous = previousRoot.pendingIntents.activationsByRequestId;
  if (current === previous) return;
  for (const requestId of new Set([
    ...Object.keys(current),
    ...Object.keys(previous)
  ])) {
    const currentActivation = current[requestId];
    const previousActivation = previous[requestId];
    if (currentActivation === previousActivation) continue;
    if (currentActivation?.initialGoalControl) {
      target.add(currentActivation.agentSessionId);
    }
    if (previousActivation?.initialGoalControl) {
      target.add(previousActivation.agentSessionId);
    }
  }
}

function addCanonicalGoalCandidates(
  target: Set<string>,
  intent: RootEngineIntent,
  state: RootAgentSessionEngineState,
  previousRoot: RootAgentSessionEngineState
): void {
  const candidates = new Set<string>();
  switch (intent.type) {
    case "session/snapshotReceived":
      addSessionInputs(candidates, intent.sessions);
      break;
    case "session/upserted":
      addSessionInputs(candidates, [intent.session]);
      break;
    case "session/metadataPatched":
      addSessionID(candidates, intent.agentSessionId);
      break;
    case "session/detailSnapshotReceived":
    case "session/historyAuthoritativeSnapshotReceived":
      addSessionInputs(candidates, [intent.session, ...intent.childSessions]);
      break;
    case "session/removed":
      addSessionID(candidates, intent.agentSessionId);
      break;
    case "engine/commandResult":
      addChangedCanonicalSessionIDs(candidates, state, previousRoot);
  }
  for (const agentSessionId of candidates) {
    const currentGoal =
      state.sessionLifecycle.sessionsById[agentSessionId]?.goal ?? null;
    const previousGoal =
      previousRoot.sessionLifecycle.sessionsById[agentSessionId]?.goal ?? null;
    if (!sessionGoalsEqual(currentGoal, previousGoal)) {
      target.add(agentSessionId);
    }
  }
}

function addChangedCanonicalSessionIDs(
  target: Set<string>,
  state: RootAgentSessionEngineState,
  previousRoot: RootAgentSessionEngineState
): void {
  const current = state.sessionLifecycle.sessionsById;
  const previous = previousRoot.sessionLifecycle.sessionsById;
  for (const agentSessionId of new Set([
    ...Object.keys(current),
    ...Object.keys(previous)
  ])) {
    if (current[agentSessionId] !== previous[agentSessionId]) {
      target.add(agentSessionId);
    }
  }
}

function addSessionInputs(
  target: Set<string>,
  sessions: readonly { agentSessionId: string }[]
): void {
  for (const session of sessions) {
    addSessionID(target, session.agentSessionId);
  }
}

function addSessionID(target: Set<string>, rawAgentSessionId: string): void {
  const agentSessionId = rawAgentSessionId.trim();
  if (agentSessionId) target.add(agentSessionId);
}

function projectSessionGoalControlSettlement(
  operation: SessionGoalControlOperation
): SessionGoalControlSettlement {
  return {
    action: operation.action,
    agentSessionId: operation.agentSessionId,
    clientSubmitId: operation.clientSubmitId,
    errorCode: operation.errorCode,
    errorMessage: operation.errorMessage,
    errorReason: operation.errorReason,
    status: operation.status
  };
}

export function sessionGoalControlPresentationsEqual(
  left: SessionGoalControlPresentation,
  right: SessionGoalControlPresentation
): boolean {
  return (
    left.agentSessionId === right.agentSessionId &&
    sessionGoalsEqual(left.goal, right.goal) &&
    left.optimistic === right.optimistic &&
    left.status === right.status
  );
}

function sessionGoalControlSettlementsEqual(
  left: SessionGoalControlSettlement,
  right: SessionGoalControlSettlement
): boolean {
  return (
    left.action === right.action &&
    left.agentSessionId === right.agentSessionId &&
    left.clientSubmitId === right.clientSubmitId &&
    left.errorCode === right.errorCode &&
    left.errorMessage === right.errorMessage &&
    left.errorReason === right.errorReason &&
    left.status === right.status
  );
}

function isTerminalSessionGoalStatus(
  status: string | null | undefined
): boolean {
  switch ((status ?? "").trim().toLowerCase()) {
    case "complete":
    case "completed":
    case "done":
      return true;
    default:
      return false;
  }
}
