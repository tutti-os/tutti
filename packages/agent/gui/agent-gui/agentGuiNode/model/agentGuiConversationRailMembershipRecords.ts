import {
  isPendingActivationViable,
  selectPendingActivations,
  selectSessionMutations,
  selectWorkspaceAgentConsumerSessions,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";

export function projectConversationRailMembershipRecords(
  state: AgentSessionEngineState
) {
  const sessions = selectWorkspaceAgentConsumerSessions(state);
  const canonicalIds = new Set(
    sessions.map((item) => item.session.agentSessionId)
  );
  const sessionsById = new Map(
    sessions.map((item) => [item.session.agentSessionId, item.session] as const)
  );
  return [
    ...sessions.map((item) => ({
      agentTargetId: item.session.agentTargetId,
      id: item.session.agentSessionId,
      pinnedAtUnixMs: item.session.pinnedAtUnixMs ?? null,
      railSectionKey: item.session.railSectionKey?.trim() || null,
      title: item.session.title
    })),
    ...selectPendingActivations(state)
      .filter(
        (record) =>
          record.mode === "new" &&
          isPendingActivationViable(record) &&
          !canonicalIds.has(record.agentSessionId)
      )
      .map((record) => ({
        agentTargetId: record.agentTargetId,
        id: record.agentSessionId,
        pendingCreation: true,
        pinnedAtUnixMs: null,
        projectionSource: "pending_activation" as const,
        railSectionKey: record.railSectionKey?.trim() || null,
        title: record.title ?? ""
      })),
    ...selectSessionMutations(state).flatMap((record) => {
      const targetAgentSessionId =
        record.kind === "forkThroughTurn"
          ? record.targetAgentSessionId.trim()
          : "";
      if (
        record.kind !== "forkThroughTurn" ||
        record.status !== "inFlight" ||
        !targetAgentSessionId ||
        canonicalIds.has(targetAgentSessionId)
      ) {
        return [];
      }
      const source = sessionsById.get(record.agentSessionIds[0]);
      if (!source || source.workspaceId !== record.workspaceId) {
        return [];
      }
      return [
        {
          agentTargetId: source.agentTargetId,
          id: targetAgentSessionId,
          pendingCreation: true,
          pinnedAtUnixMs: null,
          railSectionKey: source.railSectionKey?.trim() || null,
          title: source.title
        }
      ];
    })
  ];
}
