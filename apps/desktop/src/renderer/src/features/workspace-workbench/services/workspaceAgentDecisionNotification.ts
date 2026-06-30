import {
  approvalOptionDisplayLabel,
  getPromptToolDetails,
  isPromptRequestIdTitle,
  managedAgentRoundedIconUrl,
  type WorkspaceAgentMessageCenterItem
} from "@tutti-os/agent-gui/agent-message-center";
import { formatAgentGuiConversationPlainTitle } from "@tutti-os/agent-gui/workbench/sessionTitle";

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

export function buildWorkspaceAgentDecisionNotification(
  item: WorkspaceAgentMessageCenterItem,
  labels: {
    commandLabel: string;
    fallbackAgentName: string;
    planModes: Array<{ id: string; label: string }>;
  }
): WorkspaceAgentDecisionNotification | null {
  const prompt = item.pendingPrompt;
  if (!prompt) {
    return null;
  }
  const agentName =
    formatWorkspaceAgentProviderName(item.provider) || labels.fallbackAgentName;
  const agentIconUrl = managedAgentRoundedIconUrl(item.provider);
  const conversationTitle = formatAgentGuiConversationPlainTitle(item);
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
          label: approvalOptionDisplayLabel(option),
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
  labels: { commandLabel: string }
): string {
  const command = getPromptToolDetails(prompt.input).find(
    (detail) => detail.kind === "command"
  )?.value;
  if (command) {
    return `${labels.commandLabel}: ${command}`;
  }
  const title = prompt.title.trim();
  if (!title || isPromptRequestIdTitle(title)) {
    return labels.commandLabel;
  }
  return title;
}

function formatWorkspaceAgentProviderName(provider: string): string {
  return provider
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
