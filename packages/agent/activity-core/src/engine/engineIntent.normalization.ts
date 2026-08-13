import type {
  AgentSessionEngineIdentity,
  EngineClock,
  EngineIntent
} from "./types.ts";

export function withEngineObservationTime(
  intent: EngineIntent,
  clock: EngineClock
): EngineIntent {
  if (
    (intent.type === "session/detailSnapshotReceived" ||
      intent.type === "session/snapshotReceived" ||
      intent.type === "session/upserted") &&
    intent.observedAtUnixMs === undefined
  ) {
    return { ...intent, observedAtUnixMs: clock.nowUnixMs() };
  }
  return intent;
}

export function intentForEngineIdentity(
  intent: EngineIntent,
  identity: AgentSessionEngineIdentity
): EngineIntent | null {
  if ("workspaceId" in intent && intent.workspaceId !== undefined) {
    if (intent.workspaceId.trim() !== identity.workspaceId) {
      return null;
    }
  }
  if (intent.type === "session/upserted") {
    return intent.session.workspaceId === identity.workspaceId ? intent : null;
  }
  if (intent.type === "session/snapshotReceived") {
    const sessions = intent.sessions.filter(
      (session) => session.workspaceId === identity.workspaceId
    );
    if (sessions.length === intent.sessions.length) return intent;
    const workspaceMismatchSessionIds = intent.sessions
      .filter((session) => session.workspaceId !== identity.workspaceId)
      .map((session) => session.agentSessionId.trim())
      .filter(Boolean);
    return {
      ...intent,
      sessions,
      workspaceMismatchSessionIds: [
        ...(intent.workspaceMismatchSessionIds ?? []),
        ...workspaceMismatchSessionIds
      ]
    };
  }
  return intent;
}
