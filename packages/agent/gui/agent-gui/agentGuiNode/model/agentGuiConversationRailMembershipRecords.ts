import {
  isPendingActivationViable,
  selectPendingActivations,
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
  return [
    ...sessions.map((item) => ({
      id: item.session.agentSessionId,
      pinnedAtUnixMs: item.session.pinnedAtUnixMs ?? null
    })),
    ...selectPendingActivations(state)
      .filter(
        (record) =>
          record.mode === "new" &&
          isPendingActivationViable(record) &&
          !canonicalIds.has(record.agentSessionId)
      )
      .map((record) => ({
        id: record.agentSessionId,
        pinnedAtUnixMs: null,
        projectionSource: "pending_activation" as const
      }))
  ];
}
