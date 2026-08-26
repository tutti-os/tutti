import type { WorkspaceAgentMessageCenterItem } from "@tutti-os/agent-gui/agent-message-center";
import { resolveWorkspaceAgentDecisionIdentity } from "./workspaceAgentDecisionNotificationIdentity.ts";

export interface WorkspaceAgentDecisionSubmitInput {
  action?: string;
  optionId?: string;
  payload?: Record<string, unknown>;
  requestId: string;
}

export interface WorkspaceAgentDecisionToastOption {
  description?: string;
  id: string;
  label: string;
  submitInput: WorkspaceAgentDecisionSubmitInput;
}

export interface WorkspaceAgentDecisionNotification {
  agentIconUrl: string;
  agentName: string;
  conversationTitle: string;
  description: string;
  options: WorkspaceAgentDecisionToastOption[];
  prompt: NonNullable<WorkspaceAgentMessageCenterItem["pendingPrompt"]>;
}

export interface WorkspaceAgentDecisionNotificationLabels {
  approvalOptionLabel: (option: {
    id: string;
    kind: string;
    label: string;
  }) => string;
  commandLabel: string;
  fallbackAgentIconUrl: string;
  fallbackAgentName: string;
  isRequestIdTitle: (value: string) => boolean;
  planModes: Array<{ id: string; label: string }>;
  promptCommand: (input: Record<string, unknown> | null) => string | null;
}

export function buildWorkspaceAgentDecisionNotification(
  item: WorkspaceAgentMessageCenterItem,
  labels: WorkspaceAgentDecisionNotificationLabels
): WorkspaceAgentDecisionNotification | null {
  const prompt = item.pendingPrompt;
  if (!prompt) {
    return null;
  }
  const { agentIconUrl, agentName } = resolveWorkspaceAgentDecisionIdentity({
    agentAvatarUrl: item.agentAvatarUrl,
    agentName: item.agentName,
    fallbackAgentIconUrl: labels.fallbackAgentIconUrl,
    fallbackAgentName: labels.fallbackAgentName
  });
  const conversationTitle = item.title.trim();
  if (prompt.kind === "plan-implementation") {
    return {
      agentIconUrl,
      agentName,
      conversationTitle,
      description: prompt.title,
      options: [],
      prompt
    };
  }
  switch (prompt.kind) {
    case "approval":
      return {
        agentIconUrl,
        agentName,
        conversationTitle,
        description: approvalNotificationDescription(prompt, labels),
        options: prompt.options.map((option) => ({
          description: option.description,
          id: option.id,
          label: labels.approvalOptionLabel(option),
          submitInput: {
            requestId: prompt.requestId,
            optionId: option.id
          }
        })),
        prompt
      };
    case "exit-plan":
      return {
        agentIconUrl,
        agentName,
        conversationTitle,
        description: prompt.title,
        options: labels.planModes.map((mode) => ({
          id: mode.id,
          label: mode.label,
          submitInput: {
            requestId: prompt.requestId,
            action: "allow",
            optionId: mode.id
          }
        })),
        prompt
      };
    case "ask-user": {
      const question = prompt.questions[0] ?? null;
      if (!question) {
        return null;
      }
      return {
        agentIconUrl,
        agentName,
        conversationTitle,
        description: question.question || prompt.title,
        options: question.options.map((option) => ({
          description: option.description,
          id: `${question.id}:${option.label}`,
          label: option.label,
          submitInput: {
            requestId: prompt.requestId,
            action: "submit",
            payload: {
              answers: [option.label],
              answersByQuestionId: {
                [question.id]: question.multiSelect
                  ? [option.label]
                  : option.label
              }
            }
          }
        })),
        prompt
      };
    }
    default:
      return null;
  }
}

function approvalNotificationDescription(
  prompt: Extract<
    NonNullable<WorkspaceAgentMessageCenterItem["pendingPrompt"]>,
    { kind: "approval" }
  >,
  labels: Pick<
    WorkspaceAgentDecisionNotificationLabels,
    "commandLabel" | "isRequestIdTitle" | "promptCommand"
  >
): string {
  const command = labels.promptCommand(prompt.input);
  if (command) {
    return `${labels.commandLabel}: ${command}`;
  }
  const title = prompt.title.trim();
  if (!title || labels.isRequestIdTitle(title)) {
    return labels.commandLabel;
  }
  return title;
}

export function isWorkspaceAgentDecisionNotificationPresentable(
  notification: WorkspaceAgentDecisionNotification | null
): notification is WorkspaceAgentDecisionNotification {
  return Boolean(
    notification &&
    (notification.prompt.kind === "plan-implementation" ||
      notification.options.length > 0)
  );
}
