import type {
  AgentActivityMessage,
  AgentActivitySession
} from "@tutti-os/agent-activity-core";
import { translate } from "../i18n/index";
import { normalizeAgentTitleText } from "./utils/agentTitleText";
import { workspaceAgentProviderLabel } from "./workspaceAgentProviderLabel";
import { resolveDisplayableWorkspaceAgentSessionTitle } from "./workspaceAgentSessionTitle";
import { fallbackSummary } from "./workspaceAgentLatestActivitySummary";
import { isWorkspaceAgentSyntheticControlMessage } from "./workspaceAgentSyntheticMessages";
import type { WorkspaceAgentActivityStatus } from "./workspaceAgentActivityListTypes";

export function resolveWorkspaceAgentActivityTitle(
  session: AgentActivitySession,
  messages: readonly AgentActivityMessage[] = []
): string {
  const sessionTitle = resolveDisplayableWorkspaceAgentSessionTitle(session);
  const userMessageTitle = firstUserMessageText(messages);
  if (
    sessionTitle &&
    !isProviderPlaceholderTitleForSession(sessionTitle, session)
  ) {
    return sessionTitle;
  }
  return userMessageTitle || sessionTitle || workspaceAgentUntitledTaskLabel();
}

function isProviderPlaceholderTitleForSession(
  title: string,
  session: AgentActivitySession
): boolean {
  const provider = normalizeProvider(session.provider);
  if (!provider) {
    return false;
  }
  const normalizedTitle = title.trim().toLowerCase();
  return (
    workspaceAgentProviderLabel(provider).toLowerCase() === normalizedTitle
  );
}

export function resolveLatestActivity(
  messages: readonly AgentActivityMessage[],
  status: WorkspaceAgentActivityStatus,
  actors: { agentName: string; userName: string }
): { actorName: string; summary: string } {
  const latestMessage = latestDisplayableMessage(messages);
  if (latestMessage) {
    return {
      actorName:
        messageRole(latestMessage.message) === "user"
          ? actors.userName
          : actors.agentName,
      summary: latestMessage.text
    };
  }
  return {
    actorName: actors.agentName,
    summary: fallbackSummary(status)
  };
}

function firstUserMessageText(
  messages: readonly AgentActivityMessage[]
): string {
  const firstUserMessage = messages
    .map((message) => ({
      message,
      text: messageDisplayText(message),
      time: messageTime(message)
    }))
    .filter(
      (item) => messageRole(item.message) === "user" && item.text.length > 0
    )
    .sort((left, right) => {
      const timeDiff = (left.time ?? 0) - (right.time ?? 0);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return left.message.messageId.localeCompare(right.message.messageId);
    })[0];

  return firstUserMessage?.text ?? "";
}

function latestDisplayableMessage(messages: readonly AgentActivityMessage[]): {
  message: AgentActivityMessage;
  text: string;
  time?: number;
} | null {
  return (
    messages
      .map((message) => ({
        message,
        text: messageDisplayText(message),
        time: messageTime(message)
      }))
      .filter(
        (item) =>
          item.text.length > 0 &&
          normalizeToken(item.message.kind) !== "tool_call"
      )
      .sort((left, right) => {
        const timeDiff = (right.time ?? 0) - (left.time ?? 0);
        if (timeDiff !== 0) {
          return timeDiff;
        }
        return right.message.messageId.localeCompare(left.message.messageId);
      })[0] ?? null
  );
}

function messageDisplayText(message: AgentActivityMessage): string {
  const payload = message.payload ?? {};
  const text = normalizeAgentTitleText(
    compactText(
      stringValue(payload.displayPrompt) ||
        stringValue(payload.text) ||
        stringValue(payload.content) ||
        stringValue(payload.message) ||
        stringValue(payload.body) ||
        stringValue(payload.title) ||
        ""
    )
  );
  return isWorkspaceAgentSyntheticControlMessage(text) ? "" : text;
}

function messageRole(message: AgentActivityMessage): string {
  return normalizeToken(message.role);
}

function messageTime(message: AgentActivityMessage): number | undefined {
  return (
    message.occurredAtUnixMs ??
    message.completedAtUnixMs ??
    message.startedAtUnixMs
  );
}

function normalizeToken(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function workspaceAgentUntitledTaskLabel(): string {
  return normalizeAgentTitleText(
    translate("agentHost.workspaceAgentsUntitledTask")
  );
}

function normalizeProvider(provider: string | undefined): string | null {
  const trimmed = provider?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
