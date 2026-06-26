import { loadAllAgentSessionMessages } from "@tutti-os/agent-activity-core";
import type { WorkspaceAgentActivityMessage } from "../shared/workspaceAgentActivityTypes";

const DEFAULT_WORKSPACE_AGENT_MESSAGES_LIMIT = 20;
const DEFAULT_WORKSPACE_AGENT_MESSAGES_MAX_PAGES = 5;

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
  maxPages = DEFAULT_WORKSPACE_AGENT_MESSAGES_MAX_PAGES,
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
      maxPages,
      listPage: async (cursor) => {
        const response = await listSessionMessages({
          workspaceId: normalizedWorkspaceId,
          agentSessionId,
          afterVersion: cursor,
          limit
        });
        return {
          messages: response.messages,
          // Preserve the server's signal, falling back to a full-page heuristic
          // for sources that omit `hasMore`.
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
  const byKey = new Map<string, WorkspaceAgentActivityMessage>();
  for (const message of previous) {
    byKey.set(workspaceAgentMessageMergeKey(message), message);
  }
  for (const message of incoming) {
    const key = workspaceAgentMessageMergeKey(message);
    const fallbackKey = workspaceAgentMessageFallbackMergeKey(message);
    const fallbackMessage =
      (message.id ?? 0) > 0 && fallbackKey !== key
        ? byKey.get(fallbackKey)
        : undefined;
    const previousMessage = byKey.get(key);
    if (fallbackMessage) {
      byKey.delete(fallbackKey);
    }
    byKey.set(key, {
      ...fallbackMessage,
      ...previousMessage,
      ...message,
      payload: {
        ...(fallbackMessage?.payload ?? {}),
        ...(previousMessage?.payload ?? {}),
        ...(message.payload ?? {})
      }
    });
  }

  return [...byKey.values()].sort(
    (left, right) => (left.id ?? 0) - (right.id ?? 0)
  );
}

function workspaceAgentMessageMergeKey(
  message: WorkspaceAgentActivityMessage
): string {
  if (message.messageId?.trim()) {
    return workspaceAgentMessageFallbackMergeKey(message);
  }
  if ((message.id ?? 0) > 0) {
    return `id:${message.id}`;
  }
  return workspaceAgentMessageFallbackMergeKey(message);
}

function workspaceAgentMessageFallbackMergeKey(
  message: WorkspaceAgentActivityMessage
): string {
  const messageId = message.messageId?.trim();
  return `message:${message.agentSessionId}:${messageId}`;
}
