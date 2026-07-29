import type { SessionHistoryAuthoritativeSnapshotReceivedIntent } from "./sessionLifecycle.types.ts";
import type {
  SessionLifecycleState,
  SessionOperationState
} from "./sessionLifecycle.types.ts";
import {
  replaceCanonicalTurnSnapshot,
  upsertCanonicalSession
} from "./sessionEntities.reducer.ts";

export function replaceAuthoritativeSessionHistory(
  state: SessionLifecycleState,
  intent: SessionHistoryAuthoritativeSnapshotReceivedIntent,
  createOperation: () => SessionOperationState
): SessionLifecycleState {
  const agentSessionId = intent.agentSessionId.trim();
  const workspaceId = intent.workspaceId.trim();
  if (
    !agentSessionId ||
    !workspaceId ||
    intent.session.agentSessionId.trim() !== agentSessionId ||
    intent.session.workspaceId.trim() !== workspaceId
  ) {
    return state;
  }
  let next = upsertCanonicalSession(state, intent.session, createOperation);
  for (const childSession of intent.childSessions) {
    if (childSession.workspaceId.trim() !== workspaceId) continue;
    next = upsertCanonicalSession(next, childSession, createOperation);
  }
  // Detail embeds latest/active turns. Apply the ordered effective collection
  // last so those denormalized fields cannot resurrect a retracted Turn.
  return replaceCanonicalTurnSnapshot(next, agentSessionId, intent.turns);
}
