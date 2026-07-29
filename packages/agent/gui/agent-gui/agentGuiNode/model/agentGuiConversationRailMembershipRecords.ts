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
        pinnedAtUnixMs: null,
        projectionSource: "pending_activation" as const,
        railSectionKey: record.railSectionKey?.trim() || null,
        title: record.title ?? ""
      }))
  ];
}
