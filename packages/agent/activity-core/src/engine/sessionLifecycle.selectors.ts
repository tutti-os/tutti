import type {
  AgentActivityDisplayStatus,
  AgentActivityInteraction,
  AgentActivityTurn
} from "../types.ts";
import type { AgentSessionEngineState } from "./types.ts";
import type {
  InteractionResponseState,
  SessionCancelState,
  CanonicalAgentSession,
  SessionOperationState
} from "./sessionLifecycle.types.ts";
import {
  canonicalInteractionKey,
  canonicalTurnKey
} from "./sessionEntityKeys.ts";

export interface WorkspaceAgentConsumerSession {
  activeTurn: AgentActivityTurn | null;
  displayStatus: AgentActivityDisplayStatus;
  latestTurn: AgentActivityTurn | null;
  pendingInteractions: readonly AgentActivityInteraction[];
  session: CanonicalAgentSession;
}

export interface WorkspaceAgentConsumerCounts {
  canceled: number;
  completed: number;
  failed: number;
  idle: number;
  waiting: number;
  working: number;
}

export interface EngineSubmitAvailability {
  reason?: "active_turn" | "waiting";
  state: "available" | "blocked";
}

const EMPTY_CONSUMER_COUNTS: WorkspaceAgentConsumerCounts = {
  canceled: 0,
  completed: 0,
  failed: 0,
  idle: 0,
  waiting: 0,
  working: 0
};

export function selectEngineSession(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): CanonicalAgentSession | null {
  const id = agentSessionId?.trim() ?? "";
  if (!state.sessionLifecycle.sessionsById[id]) return null;
  return state.sessionLifecycle.sessionsById[id] ?? null;
}

export function selectEngineTurnsForSession(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): readonly AgentActivityTurn[] {
  const id = agentSessionId?.trim() ?? "";
  if (!state.sessionLifecycle.sessionsById[id]) return [];
  return Object.values(state.sessionLifecycle.turnsById)
    .filter((turn) => turn.agentSessionId === id)
    .sort(
      (left, right) =>
        left.startedAtUnixMs - right.startedAtUnixMs ||
        left.turnId.localeCompare(right.turnId)
    );
}

export function selectEngineActiveTurn(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): AgentActivityTurn | null {
  const session = selectEngineSession(state, agentSessionId);
  return session?.activeTurnId
    ? (state.sessionLifecycle.turnsById[
        canonicalTurnKey(session.agentSessionId, session.activeTurnId)
      ] ?? null)
    : null;
}

export function selectEngineTurn(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined,
  turnId: string | null | undefined
): AgentActivityTurn | null {
  const sessionId = agentSessionId?.trim() ?? "";
  const id = turnId?.trim() ?? "";
  return sessionId && id && state.sessionLifecycle.sessionsById[sessionId]
    ? (state.sessionLifecycle.turnsById[canonicalTurnKey(sessionId, id)] ??
        null)
    : null;
}

export function selectEngineInteraction(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined,
  turnId: string | null | undefined,
  requestId: string | null | undefined
): AgentActivityInteraction | null {
  const sessionId = agentSessionId?.trim() ?? "";
  const turn = turnId?.trim() ?? "";
  const id = requestId?.trim() ?? "";
  if (
    !sessionId ||
    !turn ||
    !id ||
    !state.sessionLifecycle.sessionsById[sessionId]
  ) {
    return null;
  }
  const interaction =
    state.sessionLifecycle.interactionsById[
      canonicalInteractionKey(sessionId, turn, id)
    ];
  return interaction &&
    state.sessionLifecycle.turnsById[
      canonicalTurnKey(sessionId, interaction.turnId)
    ]
    ? interaction
    : null;
}

export function selectEngineInteractionResponse(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined,
  turnId: string | null | undefined,
  requestId: string | null | undefined
): InteractionResponseState | null {
  const sessionId = agentSessionId?.trim() ?? "";
  const turn = turnId?.trim() ?? "";
  const id = requestId?.trim() ?? "";
  return sessionId && turn && id
    ? (state.sessionLifecycle.interactionResponsesById[
        canonicalInteractionKey(sessionId, turn, id)
      ] ?? null)
    : null;
}

export function selectEngineSessionIsRespondingToInteraction(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): boolean {
  const id = agentSessionId?.trim() ?? "";
  return Object.values(state.sessionLifecycle.interactionResponsesById).some(
    (response) =>
      response.agentSessionId === id &&
      (response.status === "responding" || response.status === "unknown")
  );
}

export function selectEngineSessionSettingsUpdate(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
) {
  const id = agentSessionId?.trim() ?? "";
  return (
    state.sessionLifecycle.operationBySessionId[id]?.settingsUpdate ?? null
  );
}

export function selectEngineInteractionResponseError(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): string | null {
  const id = agentSessionId?.trim() ?? "";
  return (
    Object.values(state.sessionLifecycle.interactionResponsesById)
      .filter((response) => response.agentSessionId === id)
      .sort((left, right) => right.commandId.localeCompare(left.commandId))
      .find((response) => response.errorMessage)?.errorMessage ?? null
  );
}

export function selectEngineLatestTurn(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): AgentActivityTurn | null {
  return selectEngineTurnsForSession(state, agentSessionId).at(-1) ?? null;
}

export function selectEngineInteractionsForSession(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): readonly AgentActivityInteraction[] {
  const id = agentSessionId?.trim() ?? "";
  if (!state.sessionLifecycle.sessionsById[id]) return [];
  return Object.values(state.sessionLifecycle.interactionsById)
    .filter(
      (interaction) =>
        interaction.agentSessionId === id &&
        Boolean(
          state.sessionLifecycle.turnsById[
            canonicalTurnKey(id, interaction.turnId)
          ]
        )
    )
    .sort(
      (left, right) =>
        left.createdAtUnixMs - right.createdAtUnixMs ||
        left.requestId.localeCompare(right.requestId)
    );
}

export function selectEnginePendingInteractions(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): readonly AgentActivityInteraction[] {
  return selectEngineInteractionsForSession(state, agentSessionId).filter(
    (interaction) => interaction.status === "pending"
  );
}

export function selectEngineSubmitAvailability(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): EngineSubmitAvailability | null {
  const id = agentSessionId?.trim() ?? "";
  const session = state.sessionLifecycle.sessionsById[id];
  if (!session) {
    return null;
  }
  if (selectEnginePendingInteractions(state, id).length > 0) {
    return { state: "blocked", reason: "waiting" };
  }
  const activeTurn = selectEngineActiveTurn(state, id);
  if (activeTurn && activeTurn.phase !== "settled") {
    return { state: "blocked", reason: "active_turn" };
  }
  return { state: "available" };
}

export function selectEngineCancelPending(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): boolean {
  const id = agentSessionId?.trim() ?? "";
  const status = state.sessionLifecycle.operationBySessionId[id]?.cancel.status;
  return status === "requested" || status === "awaitingTurn";
}

export function selectEngineCancelState(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): SessionCancelState | null {
  const id = agentSessionId?.trim() ?? "";
  return state.sessionLifecycle.operationBySessionId[id]?.cancel ?? null;
}

export function selectEngineSessionOperation(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): SessionOperationState | null {
  const id = agentSessionId?.trim() ?? "";
  return state.sessionLifecycle.operationBySessionId[id] ?? null;
}

export function selectEngineHasPendingInteractions(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): boolean {
  return selectEnginePendingInteractions(state, agentSessionId).length > 0;
}

export function selectEngineSessionError(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): string | null {
  const id = agentSessionId?.trim() ?? "";
  const record = state.sessionLifecycle.operationBySessionId[id];
  return (
    record?.operationError ??
    selectEngineActiveTurn(state, id)?.error?.message ??
    null
  );
}

export function selectWorkspaceAgentConsumerSessions(
  state: AgentSessionEngineState
): readonly WorkspaceAgentConsumerSession[] {
  return Object.values(state.sessionLifecycle.sessionsById).map((session) => {
    const activeTurn = selectEngineActiveTurn(state, session.agentSessionId);
    const latestTurn = selectEngineLatestTurn(state, session.agentSessionId);
    const pendingInteractions = selectEnginePendingInteractions(
      state,
      session.agentSessionId
    );
    return {
      activeTurn,
      displayStatus: displayStatusFromCanonicalState({
        activeTurn,
        latestTurn,
        pendingInteractions
      }),
      latestTurn,
      pendingInteractions,
      session
    };
  });
}

export function selectWorkspaceAgentConsumerSession(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): WorkspaceAgentConsumerSession | null {
  const id = agentSessionId?.trim() ?? "";
  const session = state.sessionLifecycle.sessionsById[id];
  if (!session) return null;
  const activeTurn = selectEngineActiveTurn(state, id);
  const latestTurn = selectEngineLatestTurn(state, id);
  const pendingInteractions = selectEnginePendingInteractions(state, id);
  return {
    activeTurn,
    displayStatus: displayStatusFromCanonicalState({
      activeTurn,
      latestTurn,
      pendingInteractions
    }),
    latestTurn,
    pendingInteractions,
    session
  };
}

export function selectWorkspaceAgentConsumerCounts(
  state: AgentSessionEngineState
): WorkspaceAgentConsumerCounts {
  return selectWorkspaceAgentConsumerSessions(state).reduce(
    (counts, item) => {
      counts[item.displayStatus] += 1;
      return counts;
    },
    { ...EMPTY_CONSUMER_COUNTS }
  );
}

function displayStatusFromCanonicalState(state: {
  activeTurn: AgentActivityTurn | null;
  latestTurn: AgentActivityTurn | null;
  pendingInteractions: readonly AgentActivityInteraction[];
}): AgentActivityDisplayStatus {
  if (state.pendingInteractions.length > 0) return "waiting";
  if (state.activeTurn && state.activeTurn.phase !== "settled") {
    return state.activeTurn.phase === "waiting" ? "waiting" : "working";
  }
  if (!state.latestTurn || state.latestTurn.phase !== "settled") return "idle";
  switch (state.latestTurn.outcome) {
    case "failed":
      return "failed";
    case "canceled":
    case "interrupted":
      return "canceled";
    case "completed":
      return "completed";
    default:
      return "idle";
  }
}
