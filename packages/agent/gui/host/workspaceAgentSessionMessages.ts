import {
  loadAllAgentSessionMessages,
  mergeAgentActivityMessages
} from "@tutti-os/agent-activity-core";
import {
  isWorkspaceAgentActivityOptimisticMessage,
  mergeWorkspaceAgentActivityDurableAndOverlayMessages,
  type WorkspaceAgentActivityMessage
} from "../shared/workspaceAgentActivityTypes";

const DEFAULT_WORKSPACE_AGENT_MESSAGES_LIMIT = 20;

export interface WorkspaceAgentActivitySessionMessagesPage {
  messages: WorkspaceAgentActivityMessage[];
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
  ) => Promise<WorkspaceAgentActivitySessionMessagesPage>;
}): Promise<WorkspaceAgentActivityMessage[]> {
  const normalizedWorkspaceId = workspaceId?.trim() || "";
  const { messages } =
    await loadAllAgentSessionMessages<WorkspaceAgentActivityMessage>({
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
  previous: readonly WorkspaceAgentActivityMessage[],
  incoming: readonly WorkspaceAgentActivityMessage[]
): WorkspaceAgentActivityMessage[] {
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
