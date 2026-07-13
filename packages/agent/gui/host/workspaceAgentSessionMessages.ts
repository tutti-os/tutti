import {
  loadAllAgentSessionMessages,
  mergeAgentActivityMessages,
  type AgentActivityMessage
} from "@tutti-os/agent-activity-core";
import {
  isWorkspaceAgentActivityOptimisticMessage,
  mergeWorkspaceAgentActivityDurableAndOverlayMessages
} from "../shared/workspaceAgentMessageOverlay";

const DEFAULT_WORKSPACE_AGENT_MESSAGES_LIMIT = 20;

export interface AgentActivitySessionMessagesPage {
  messages: AgentActivityMessage[];
  latestVersion?: number;
  hasMore?: boolean;
}

export interface WorkspaceAgentActivityListSessionMessagesInput {
  workspaceId: string;
  agentSessionId: string;
  afterVersion?: number;
  beforeVersion?: number;
  limit?: number;
  order?: "asc" | "desc";
}

export async function loadWorkspaceAgentSessionMessagePages({
  workspaceId,
  agentSessionId,
  afterVersion = 0,
  limit = DEFAULT_WORKSPACE_AGENT_MESSAGES_LIMIT,
  maxPages,
  listSessionMessages
}: {
  workspaceId?: string;
  agentSessionId: string;
  afterVersion?: number;
  limit?: number;
  maxPages?: number;
  listSessionMessages: (
    payload: WorkspaceAgentActivityListSessionMessagesInput
  ) => Promise<AgentActivitySessionMessagesPage>;
}): Promise<AgentActivityMessage[]> {
  const normalizedWorkspaceId = workspaceId?.trim() || "";
  const { messages } = await loadAllAgentSessionMessages<AgentActivityMessage>({
    afterVersion,
    ...(maxPages === undefined ? {} : { maxPages }),
    listPage: async (cursor) => {
      const response = await listSessionMessages({
        workspaceId: normalizedWorkspaceId,
        agentSessionId,
        afterVersion: cursor,
        limit
      });
      return {
        messages: response.messages,
        latestVersion: response.latestVersion,
        hasMore:
          typeof response.hasMore === "boolean"
            ? response.hasMore
            : response.messages.length >= limit
      };
    }
  });

  return messages;
}

export function mergeWorkspaceAgentMessages(
  previous: readonly AgentActivityMessage[],
  incoming: readonly AgentActivityMessage[]
): AgentActivityMessage[] {
  const previousDurableMessages = previous.filter(
    (message) => !isWorkspaceAgentActivityOptimisticMessage(message)
  );
  const incomingDurableMessages = incoming.filter(
    (message) => !isWorkspaceAgentActivityOptimisticMessage(message)
  );
  const durableMessages = mergeAgentActivityMessages(
    previousDurableMessages,
    incomingDurableMessages
  );
  const previousOptimisticMessages = previous.filter(
    isWorkspaceAgentActivityOptimisticMessage
  );
  const incomingOptimisticMessages = incoming.filter(
    isWorkspaceAgentActivityOptimisticMessage
  );
  const localMessages = mergeAgentActivityMessages(
    previousOptimisticMessages,
    incomingOptimisticMessages
  );
  return mergeWorkspaceAgentActivityDurableAndOverlayMessages({
    durableMessages,
    localMessages
  });
}
