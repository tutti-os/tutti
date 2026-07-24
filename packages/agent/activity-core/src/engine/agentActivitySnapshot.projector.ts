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
    const snapshot: AgentActivitySnapshot = {
      workspaceId,
      sessions: selectAllWorkspaceAgentConsumerSessions(state).map((item) =>
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
      ),
      // Presence is no longer canonical activity state. Keep the legacy
      // snapshot field empty until the runtime contract drops it.
      presences: [],
      sessionMessagesById: Object.fromEntries(
        Object.entries(state.sessionMessages.messagesBySessionId).map(
          ([agentSessionId, messages]) => [agentSessionId, [...messages]]
        )
      ),
      sessionMessageWindowsById: {
        ...state.sessionMessages.windowsBySessionId
      },
      composerOptionsByTargetKey: {
        ...state.composerOptions.optionsByTargetKey
      },
      composerOptionsLoadStatusByTargetKey: Object.fromEntries(
        Object.entries(state.composerOptions.entriesByTargetKey).map(
          ([targetKey, entry]) => [targetKey, entry.status]
        )
      )
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
