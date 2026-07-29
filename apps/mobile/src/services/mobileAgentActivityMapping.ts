import type {
  AgentActivityDurableMessage,
  AgentActivitySession,
  AgentActivitySessionDetailSnapshot
} from "@tutti-os/agent-activity-core";
import {
  agentActivityMessageFromTuttidMessage,
  agentActivitySessionDetailFromTuttid,
  agentActivitySessionFromTuttidSession
} from "@tutti-os/agent-activity-tuttid-adapter";

export interface MobileAgentActivityMapping {
  mapMessage(
    message: Parameters<typeof agentActivityMessageFromTuttidMessage>[1]
  ): AgentActivityDurableMessage;
  mapSession(
    session: Parameters<typeof agentActivitySessionFromTuttidSession>[1]
  ): AgentActivitySession;
  mapSessionDetail(
    expectedAgentSessionId: string,
    detail: Parameters<typeof agentActivitySessionDetailFromTuttid>[2]
  ): AgentActivitySessionDetailSnapshot;
}

export function createMobileAgentActivityMapping(input: {
  currentUserId: string;
  workspaceId: string;
}): MobileAgentActivityMapping {
  const options = { currentUserId: input.currentUserId };
  return {
    mapMessage: (message) =>
      agentActivityMessageFromTuttidMessage(input.workspaceId, message),
    mapSession: (session) =>
      agentActivitySessionFromTuttidSession(
        input.workspaceId,
        session,
        options
      ),
    mapSessionDetail: (expectedAgentSessionId, detail) =>
      agentActivitySessionDetailFromTuttid(
        input.workspaceId,
        expectedAgentSessionId,
        detail,
        options
      )
  };
}
