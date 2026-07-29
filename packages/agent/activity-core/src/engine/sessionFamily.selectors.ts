import type {
  AgentActivityInteraction,
  AgentActivityMessage,
  AgentActivitySession
} from "../types.ts";
import { projectAgentActivitySession } from "./agentActivitySnapshot.projector.ts";
import {
  selectEngineActiveTurn,
  selectEngineInteractionsForSession,
  selectEngineLatestTurn,
  selectEnginePendingInteractions
} from "./sessionLifecycle.selectors.ts";
import type { CanonicalAgentSession } from "./sessionLifecycle.types.ts";
import type { AgentSessionEngineState } from "./types.ts";

const EMPTY_MESSAGES: readonly AgentActivityMessage[] = [];

export interface AgentSessionFamilySnapshot {
  childSessions: readonly AgentActivitySession[];
  messagesBySessionId: Readonly<
    Record<string, readonly AgentActivityMessage[]>
  >;
  pendingInteractions: readonly AgentActivityInteraction[];
  rootSession: AgentActivitySession | null;
}

interface ProjectedSessionRecord {
  activeTurn: AgentActivitySession["activeTurn"];
  interactions: readonly AgentActivityInteraction[];
  latestTurn: AgentActivitySession["latestTurn"];
  pendingInteractions: readonly AgentActivityInteraction[];
  projected: AgentActivitySession;
  session: CanonicalAgentSession;
}

/**
 * Creates a Session-family projection for one mounted consumer.
 *
 * Workspace engines notify every subscriber after a drain. This selector keeps
 * the previous result when only another root Session changed, so one streaming
 * conversation cannot force unrelated AgentGUI surfaces to render.
 */
export function createAgentSessionFamilySnapshotSelector(
  rootAgentSessionId: string | null | undefined
): (state: AgentSessionEngineState) => AgentSessionFamilySnapshot {
  const rootId = rootAgentSessionId?.trim() ?? "";
  let previousRecordsById = new Map<string, ProjectedSessionRecord>();
  let previousSnapshot: AgentSessionFamilySnapshot = {
    childSessions: [],
    messagesBySessionId: {},
    pendingInteractions: [],
    rootSession: null
  };

  return (state) => {
    if (!rootId) return previousSnapshot;

    const familySessions = Object.values(
      state.sessionLifecycle.sessionsById
    ).filter(
      (session) =>
        session.agentSessionId === rootId ||
        (session.kind === "child" &&
          session.rootAgentSessionId?.trim() === rootId)
    );
    const nextRecordsById = new Map<string, ProjectedSessionRecord>();
    const projectedSessions: AgentActivitySession[] = [];

    for (const session of familySessions) {
      const activeTurn = selectEngineActiveTurn(state, session.agentSessionId);
      const latestTurn = selectEngineLatestTurn(state, session.agentSessionId);
      const interactions = selectEngineInteractionsForSession(
        state,
        session.agentSessionId
      );
      const pendingInteractions = selectEnginePendingInteractions(
        state,
        session.agentSessionId
      );
      const previousRecord = previousRecordsById.get(session.agentSessionId);
      const reusable =
        previousRecord?.session === session &&
        previousRecord.activeTurn === activeTurn &&
        previousRecord.latestTurn === latestTurn &&
        referenceArrayEqual(previousRecord.interactions, interactions) &&
        referenceArrayEqual(
          previousRecord.pendingInteractions,
          pendingInteractions
        );
      const record: ProjectedSessionRecord = reusable
        ? previousRecord
        : {
            activeTurn,
            interactions,
            latestTurn,
            pendingInteractions,
            projected: projectAgentActivitySession(
              session,
              activeTurn,
              latestTurn,
              interactions,
              pendingInteractions
            ),
            session
          };
      nextRecordsById.set(session.agentSessionId, record);
      projectedSessions.push(record.projected);
    }

    const nextChildSessions = projectedSessions.filter(
      (session) => session.kind === "child"
    );
    const rootSession =
      projectedSessions.find((session) => session.agentSessionId === rootId) ??
      null;
    const childSessions = referenceArrayEqual(
      previousSnapshot.childSessions,
      nextChildSessions
    )
      ? previousSnapshot.childSessions
      : nextChildSessions;
    const nextMessagesBySessionId = Object.fromEntries(
      familySessions.map((session) => [
        session.agentSessionId,
        state.sessionMessages.messagesBySessionId[session.agentSessionId] ??
          EMPTY_MESSAGES
      ])
    );
    const messagesBySessionId = messageRecordsEqual(
      previousSnapshot.messagesBySessionId,
      nextMessagesBySessionId
    )
      ? previousSnapshot.messagesBySessionId
      : nextMessagesBySessionId;
    const nextPendingInteractions = projectedSessions
      .flatMap((session) => session.pendingInteractions)
      .sort(compareInteractions);
    const pendingInteractions = referenceArrayEqual(
      previousSnapshot.pendingInteractions,
      nextPendingInteractions
    )
      ? previousSnapshot.pendingInteractions
      : nextPendingInteractions;

    previousRecordsById = nextRecordsById;
    if (
      childSessions === previousSnapshot.childSessions &&
      messagesBySessionId === previousSnapshot.messagesBySessionId &&
      pendingInteractions === previousSnapshot.pendingInteractions &&
      rootSession === previousSnapshot.rootSession
    ) {
      return previousSnapshot;
    }
    previousSnapshot = {
      childSessions,
      messagesBySessionId,
      pendingInteractions,
      rootSession
    };
    return previousSnapshot;
  };
}

function referenceArrayEqual<T>(
  left: readonly T[],
  right: readonly T[]
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((item, index) => item === right[index]))
  );
}

function messageRecordsEqual(
  left: AgentSessionFamilySnapshot["messagesBySessionId"],
  right: AgentSessionFamilySnapshot["messagesBySessionId"]
): boolean {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  return (
    leftIds.length === rightIds.length &&
    rightIds.every((id) => left[id] === right[id])
  );
}

function compareInteractions(
  left: AgentActivityInteraction,
  right: AgentActivityInteraction
): number {
  return (
    left.createdAtUnixMs - right.createdAtUnixMs ||
    left.agentSessionId.localeCompare(right.agentSessionId) ||
    left.requestId.localeCompare(right.requestId)
  );
}
