import type { AgentActivityInteraction, AgentActivityTurn } from "../types.ts";
import type { AgentActivityDisplayStatus } from "../displayStatus.types.ts";
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
import { selectLatestActivationForSession } from "./pendingIntents.selectors.ts";
import { isPendingActivationViable } from "./pendingIntents.types.ts";
import { deriveCanonicalSubmitAvailability } from "./sessionLifecycle.availability.ts";

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
  reason?:
    | "active_turn"
    | "waiting"
    | "transport_reconnecting"
    | "transport_unavailable";
  state: "available" | "blocked";
}

export function selectEngineSessionRuntimeAvailability(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
) {
  const id = agentSessionId?.trim() ?? "";
  return (
    state.sessionLifecycle.operationBySessionId[id]?.runtimeAvailability ?? null
  );
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

export function selectEngineSessionDeleted(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): boolean {
  const id = agentSessionId?.trim() ?? "";
  return Boolean(id && state.sessionLifecycle.deletedSessionIds[id]);
}

export function selectEngineTurnsForSession(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): readonly AgentActivityTurn[] {
  const id = agentSessionId?.trim() ?? "";
  if (!state.sessionLifecycle.sessionsById[id]) return [];
  return Object.values(state.sessionLifecycle.turnsById)
    .filter((turn) => turn.agentSessionId === id)
    .sort(compareTurnsByOccurrence);
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
  const id = agentSessionId?.trim() ?? "";
  if (!state.sessionLifecycle.sessionsById[id]) return null;
  let latestTurn: AgentActivityTurn | null = null;
  for (const turn of Object.values(state.sessionLifecycle.turnsById)) {
    if (
      turn.agentSessionId === id &&
      (!latestTurn || compareTurnsByOccurrence(latestTurn, turn) < 0)
    ) {
      latestTurn = turn;
    }
  }
  return latestTurn;
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
  const availability = deriveCanonicalSubmitAvailability(
    state.sessionLifecycle,
    agentSessionId
  );
  if (availability.state === "missing") return null;
  return availability.reason
    ? { state: availability.state, reason: availability.reason }
    : { state: availability.state };
}

export function selectEngineCancelPending(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): boolean {
  const id = agentSessionId?.trim() ?? "";
  const status = state.sessionLifecycle.operationBySessionId[id]?.cancel.status;
  return (
    status === "requested" || status === "accepted" || status === "awaitingTurn"
  );
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

/**
 * Returns only failures from session-scoped commands. Canonical Turn failures
 * belong to the owning Turn and must not be promoted into session chrome.
 */
export function selectEngineSessionOperationError(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): string | null {
  const id = agentSessionId?.trim() ?? "";
  return (
    state.sessionLifecycle.operationBySessionId[id]?.operationError ?? null
  );
}

export function selectWorkspaceAgentConsumerSessions(
  state: AgentSessionEngineState
): readonly WorkspaceAgentConsumerSession[] {
  return selectAllWorkspaceAgentConsumerSessions(state).filter(
    (item) => item.session.kind === "root" && item.session.visible !== false
  );
}

export function selectRootAgentSessionIdsWithPendingInteractions(
  state: AgentSessionEngineState
): readonly string[] {
  const sessionIdsWithPendingInteractions = new Set<string>();
  for (const interaction of Object.values(
    state.sessionLifecycle.interactionsById
  )) {
    if (
      interaction.status === "pending" &&
      state.sessionLifecycle.turnsById[
        canonicalTurnKey(interaction.agentSessionId, interaction.turnId)
      ]
    ) {
      sessionIdsWithPendingInteractions.add(interaction.agentSessionId);
    }
  }
  const rootAgentSessionIds = new Set<string>();
  for (const session of Object.values(state.sessionLifecycle.sessionsById)) {
    if (!sessionIdsWithPendingInteractions.has(session.agentSessionId)) {
      continue;
    }
    const rootAgentSessionId =
      session.kind === "child"
        ? session.rootAgentSessionId
        : session.agentSessionId;
    if (rootAgentSessionId) rootAgentSessionIds.add(rootAgentSessionId);
  }
  return [...rootAgentSessionIds];
}

export function selectWorkspaceAgentRootConversationSessions(
  state: AgentSessionEngineState
): readonly WorkspaceAgentConsumerSession[] {
  const consumers = selectAllWorkspaceAgentConsumerSessions(state);
  const rootSessionIds = new Set(
    consumers
      .filter((consumer) => consumer.session.kind === "root")
      .map((consumer) => consumer.session.agentSessionId)
  );
  const consumersByRootSessionId = new Map<
    string,
    WorkspaceAgentConsumerSession[]
  >();

  for (const consumer of consumers) {
    const rootSessionId =
      consumer.session.kind === "child"
        ? (consumer.session.rootAgentSessionId?.trim() ?? "")
        : consumer.session.agentSessionId;
    if (!rootSessionIds.has(rootSessionId)) continue;
    const conversationConsumers =
      consumersByRootSessionId.get(rootSessionId) ?? [];
    conversationConsumers.push(consumer);
    consumersByRootSessionId.set(rootSessionId, conversationConsumers);
  }

  return consumers
    .filter((consumer) => consumer.session.kind === "root")
    .map((consumer) => {
      const conversationConsumers =
        consumersByRootSessionId.get(consumer.session.agentSessionId) ?? [];
      const pendingInteractions = conversationConsumers
        .flatMap((item) => item.pendingInteractions)
        .sort(compareInteractionsByOccurrence);
      return {
        ...consumer,
        displayStatus: rootConversationDisplayStatus(
          consumer,
          conversationConsumers,
          pendingInteractions
        ),
        pendingInteractions
      };
    });
}

export function selectAllWorkspaceAgentConsumerSessions(
  state: AgentSessionEngineState
): readonly WorkspaceAgentConsumerSession[] {
  const latestTurnsBySessionId = new Map<string, AgentActivityTurn>();
  for (const turn of Object.values(state.sessionLifecycle.turnsById)) {
    if (!state.sessionLifecycle.sessionsById[turn.agentSessionId]) continue;
    const latestTurn = latestTurnsBySessionId.get(turn.agentSessionId);
    if (!latestTurn || compareTurnsByOccurrence(latestTurn, turn) < 0) {
      latestTurnsBySessionId.set(turn.agentSessionId, turn);
    }
  }

  const pendingInteractionsBySessionId = new Map<
    string,
    AgentActivityInteraction[]
  >();
  for (const interaction of Object.values(
    state.sessionLifecycle.interactionsById
  )) {
    if (
      interaction.status !== "pending" ||
      !state.sessionLifecycle.sessionsById[interaction.agentSessionId] ||
      !state.sessionLifecycle.turnsById[
        canonicalTurnKey(interaction.agentSessionId, interaction.turnId)
      ]
    ) {
      continue;
    }
    const pendingInteractions =
      pendingInteractionsBySessionId.get(interaction.agentSessionId) ?? [];
    pendingInteractions.push(interaction);
    pendingInteractionsBySessionId.set(
      interaction.agentSessionId,
      pendingInteractions
    );
  }
  for (const pendingInteractions of pendingInteractionsBySessionId.values()) {
    pendingInteractions.sort(compareSessionInteractionsByOccurrence);
  }

  return Object.values(state.sessionLifecycle.sessionsById).map((session) => {
    const activeTurn = session.activeTurnId
      ? (state.sessionLifecycle.turnsById[
          canonicalTurnKey(session.agentSessionId, session.activeTurnId)
        ] ?? null)
      : null;
    const latestTurn =
      latestTurnsBySessionId.get(session.agentSessionId) ?? null;
    const pendingInteractions =
      pendingInteractionsBySessionId.get(session.agentSessionId) ?? [];
    return {
      activeTurn,
      displayStatus: displayStatusFromCanonicalState({
        activeTurn,
        initialActivationTurnPending: initialActivationTurnIsPending(
          state,
          session.agentSessionId,
          latestTurn
        ),
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
      initialActivationTurnPending: initialActivationTurnIsPending(
        state,
        id,
        latestTurn
      ),
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
  initialActivationTurnPending: boolean;
  latestTurn: AgentActivityTurn | null;
  pendingInteractions: readonly AgentActivityInteraction[];
}): AgentActivityDisplayStatus {
  if (state.pendingInteractions.length > 0) return "waiting";
  if (state.activeTurn && state.activeTurn.phase !== "settled") {
    return state.activeTurn.phase === "waiting" ? "waiting" : "working";
  }
  if (!state.latestTurn) {
    return state.initialActivationTurnPending ? "working" : "idle";
  }
  if (state.latestTurn.phase !== "settled") return "idle";
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

function initialActivationTurnIsPending(
  state: AgentSessionEngineState,
  agentSessionId: string,
  latestTurn: AgentActivityTurn | null
): boolean {
  if (latestTurn) return false;
  const activation = selectLatestActivationForSession(state, agentSessionId);
  return (
    activation?.mode === "new" &&
    activation.initialTurnExpected &&
    isPendingActivationViable(activation)
  );
}

function rootConversationDisplayStatus(
  root: WorkspaceAgentConsumerSession,
  consumers: readonly WorkspaceAgentConsumerSession[],
  pendingInteractions: readonly AgentActivityInteraction[]
): AgentActivityDisplayStatus {
  if (pendingInteractions.length > 0) return "waiting";
  if (consumers.some((consumer) => consumer.displayStatus === "working")) {
    return "working";
  }
  if (consumers.some((consumer) => consumer.displayStatus === "waiting")) {
    return "waiting";
  }
  return root.displayStatus;
}

function compareInteractionsByOccurrence(
  left: AgentActivityInteraction,
  right: AgentActivityInteraction
): number {
  return (
    left.createdAtUnixMs - right.createdAtUnixMs ||
    left.updatedAtUnixMs - right.updatedAtUnixMs ||
    left.agentSessionId.localeCompare(right.agentSessionId) ||
    left.turnId.localeCompare(right.turnId) ||
    left.requestId.localeCompare(right.requestId)
  );
}

function compareSessionInteractionsByOccurrence(
  left: AgentActivityInteraction,
  right: AgentActivityInteraction
): number {
  return (
    left.createdAtUnixMs - right.createdAtUnixMs ||
    left.requestId.localeCompare(right.requestId)
  );
}

function compareTurnsByOccurrence(
  left: AgentActivityTurn,
  right: AgentActivityTurn
): number {
  return (
    left.startedAtUnixMs - right.startedAtUnixMs ||
    left.turnId.localeCompare(right.turnId)
  );
}
