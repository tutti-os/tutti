import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import {
  createWorkspaceAgentActivityUserMessageIdFromClientSubmitId,
  isWorkspaceAgentActivityOptimisticMessage
} from "../../../shared/workspaceAgentActivityTypes";
import type { WorkspaceAgentActivityMessage } from "../../../shared/workspaceAgentActivityTypes";

const AGENT_GUI_OPTIMISTIC_PROMPT_OVERLAY_ENABLED = false;

export function shouldRecordAgentGUIOptimisticPromptOverlay(): boolean {
  return AGENT_GUI_OPTIMISTIC_PROMPT_OVERLAY_ENABLED;
}

export function filterAgentGUIOptimisticPromptOverlayMessages(
  messages: readonly WorkspaceAgentActivityMessage[]
): WorkspaceAgentActivityMessage[] {
  if (AGENT_GUI_OPTIMISTIC_PROMPT_OVERLAY_ENABLED) {
    return [...messages];
  }
  return messages.filter(
    (message) => !isWorkspaceAgentActivityOptimisticMessage(message)
  );
}

export function createAgentGUIOptimisticPromptMessage(input: {
  workspaceId: string;
  agentSessionId: string;
  turnId: string;
  clientSubmitId?: string;
  userId: string;
  prompt: string;
  content: AgentPromptContentBlock[];
  occurredAtUnixMs: number;
}): WorkspaceAgentActivityMessage {
  const clientSubmitMessageId = input.clientSubmitId
    ? createWorkspaceAgentActivityUserMessageIdFromClientSubmitId(
        input.clientSubmitId
      )
    : null;
  return {
    id: Math.max(1, Math.floor(input.occurredAtUnixMs)),
    workspaceId: input.workspaceId,
    agentSessionId: input.agentSessionId,
    messageId: clientSubmitMessageId ?? `optimistic:user:${input.turnId}`,
    version: Math.max(1, Math.floor(input.occurredAtUnixMs)),
    turnId: input.turnId,
    role: "user",
    kind: "text",
    payload: {
      __agentGuiOptimisticPrompt: true,
      actorId: input.userId,
      ...(input.clientSubmitId ? { clientSubmitId: input.clientSubmitId } : {}),
      content: input.content,
      text: input.prompt
    },
    occurredAtUnixMs: input.occurredAtUnixMs,
    startedAtUnixMs: input.occurredAtUnixMs
  };
}

export function createPendingAgentGUIOptimisticPromptTurnId(
  clientSubmitId: string
): string {
  return `pending:${clientSubmitId}`;
}
