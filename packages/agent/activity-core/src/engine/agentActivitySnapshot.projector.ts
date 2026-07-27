import type {
  AgentActivityInteraction,
  AgentActivitySession,
  AgentActivitySnapshot
} from "../types.ts";
import {
  selectEngineInteractionsForSession,
  selectAllWorkspaceAgentConsumerSessions
} from "./sessionLifecycle.selectors.ts";
import type { AgentSessionEngineState } from "./types.ts";

const EMPTY_PRESENCES: AgentActivitySnapshot["presences"] = [];

/**
 * Builds the legacy runtime snapshot shape as a memoized projection of the
 * canonical workspace engine. The projector must be retained per engine so
 * external-store consumers receive the same object while engine state is
 * unchanged.
 */
export function createAgentActivitySnapshotProjector(
  workspaceId: string
): (state: AgentSessionEngineState) => AgentActivitySnapshot {
  let previousState: AgentSessionEngineState | null = null;
  let previousSnapshot: AgentActivitySnapshot | null = null;
  return (state) => {
    if (state === previousState && previousSnapshot) return previousSnapshot;
    const sessions =
      previousState &&
      previousSnapshot &&
      state.sessionLifecycle === previousState.sessionLifecycle
        ? previousSnapshot.sessions
        : selectAllWorkspaceAgentConsumerSessions(state).map((item) =>
            projectSession(
              item.session,
              item.activeTurn,
              item.latestTurn,
              selectEngineInteractionsForSession(
                state,
                item.session.agentSessionId
              ),
              item.pendingInteractions
            )
          );
    const sessionMessagesById =
      previousState &&
      previousSnapshot &&
      state.sessionMessages.messagesBySessionId ===
        previousState.sessionMessages.messagesBySessionId
        ? previousSnapshot.sessionMessagesById
        : Object.fromEntries(
            Object.entries(state.sessionMessages.messagesBySessionId).map(
              ([agentSessionId, messages]) => [agentSessionId, [...messages]]
            )
          );
    const sessionMessageWindowsById =
      previousState &&
      previousSnapshot &&
      state.sessionMessages.windowsBySessionId ===
        previousState.sessionMessages.windowsBySessionId
        ? previousSnapshot.sessionMessageWindowsById
        : { ...state.sessionMessages.windowsBySessionId };
    const composerOptionsByTargetKey =
      previousState &&
      previousSnapshot &&
      state.composerOptions.optionsByTargetKey ===
        previousState.composerOptions.optionsByTargetKey
        ? previousSnapshot.composerOptionsByTargetKey
        : { ...state.composerOptions.optionsByTargetKey };
    const composerOptionsLoadStatusByTargetKey =
      previousState &&
      previousSnapshot &&
      state.composerOptions.entriesByTargetKey ===
        previousState.composerOptions.entriesByTargetKey
        ? previousSnapshot.composerOptionsLoadStatusByTargetKey
        : Object.fromEntries(
            Object.entries(state.composerOptions.entriesByTargetKey).map(
              ([targetKey, entry]) => [targetKey, entry.status]
            )
          );
    const snapshot: AgentActivitySnapshot = {
      workspaceId,
      sessions,
      // Presence is no longer canonical activity state. Keep the legacy
      // snapshot field empty until the runtime contract drops it.
      presences: EMPTY_PRESENCES,
      sessionMessagesById,
      sessionMessageWindowsById,
      composerOptionsByTargetKey,
      composerOptionsLoadStatusByTargetKey
    };
    previousState = state;
    previousSnapshot = snapshot;
    return snapshot;
  };
}

export function createEmptyAgentActivitySnapshot(
  workspaceId: string
): AgentActivitySnapshot {
  return {
    workspaceId,
    sessions: [],
    presences: [],
    sessionMessagesById: {},
    sessionMessageWindowsById: {},
    composerOptionsByTargetKey: {},
    composerOptionsLoadStatusByTargetKey: {}
  };
}

function projectSession(
  session: Omit<
    AgentActivitySession,
    | "activeTurn"
    | "latestTurn"
    | "latestTurnInteractions"
    | "pendingInteractions"
  >,
  activeTurn: AgentActivitySession["activeTurn"],
  latestTurn: AgentActivitySession["latestTurn"],
  interactions: readonly AgentActivityInteraction[],
  pendingInteractions: readonly AgentActivityInteraction[]
): AgentActivitySession {
  return {
    ...session,
    activeTurn,
    latestTurn,
    latestTurnInteractions: latestTurn
      ? interactions.filter(
          (interaction) => interaction.turnId === latestTurn.turnId
        )
      : [],
    pendingInteractions
  };
}
