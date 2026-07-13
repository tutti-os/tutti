import type { ReactElement, ReactNode } from "react";
import { AppWindow } from "lucide-react";
import {
  isRichTextMentionHref,
  parseRichTextMentionHref
} from "@tutti-os/ui-rich-text/core";
import { getActiveUiLanguage, useTranslation } from "../i18n/index";
import { formatAgentSessionMentionText } from "../shared/utils/agentSessionMentionText";
import { workspaceAgentProviderLabel } from "../shared/workspaceAgentProviderLabel";
import type { WorkspaceAgentMessageCenterItem } from "./workspaceAgentMessageCenterModel";

function messageCenterStackRawPreviewText(
  item: WorkspaceAgentMessageCenterItem
): string {
  return (
    item.digest.primary.summary.trim() ||
    item.lastAgentMessageSummary.trim() ||
    item.title
  );
}

export function messageCenterStackPreviewText(
  item: WorkspaceAgentMessageCenterItem
): string {
  return formatAgentSessionMentionText(messageCenterStackRawPreviewText(item), {
    language: getActiveUiLanguage()
  });
}

const MESSAGE_CENTER_PREVIEW_MARKDOWN_LINK_PATTERN =
  /\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g;
const MESSAGE_CENTER_PREVIEW_LABEL_ESCAPE_PATTERN = /\\([\\[\]()])/g;

type MessageCenterPreviewMentionKind =
  | "session"
  | "workspace-app"
  | "workspace-issue";

/**
 * 收起态预览只展示纯文本 + 一个静态(不可点击)的 mention 图标,复用
 * AgentMessageMarkdown 里那套富文本 chip 的视觉样式,但不渲染成 <a>——
 * 这块预览本身嵌套在外层切换展开/收起的 <button> 里,塞一个可点击链接
 * 会出现交互元素嵌套交互元素的问题。
 */
export function messageCenterStackPreviewNodes(
  item: WorkspaceAgentMessageCenterItem
): ReactNode[] {
  const text = messageCenterStackRawPreviewText(item);
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let mentionIndex = 0;

  for (const match of text.matchAll(
    MESSAGE_CENTER_PREVIEW_MARKDOWN_LINK_PATTERN
  )) {
    const [fullMatch, rawLabel = "", href = ""] = match;
    const matchStart = match.index ?? 0;
    if (matchStart > lastIndex) {
      nodes.push(text.slice(lastIndex, matchStart));
    }

    const label = rawLabel.replace(
      MESSAGE_CENTER_PREVIEW_LABEL_ESCAPE_PATTERN,
      "$1"
    );
    const mention = parseRichTextMentionHref(href, label);
    if (!mention) {
      nodes.push(isRichTextMentionHref(href) ? label : fullMatch);
    } else {
      const kind = messageCenterPreviewMentionKind(mention.providerId);
      const displayLabel = label || mention.label;
      nodes.push(
        kind ? (
          <MessageCenterPreviewMentionChip
            key={`mention-${mentionIndex}`}
            kind={kind}
            label={displayLabel}
          />
        ) : (
          displayLabel
        )
      );
      mentionIndex += 1;
    }

    lastIndex = matchStart + fullMatch.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function messageCenterPreviewMentionKind(
  providerId: string
): MessageCenterPreviewMentionKind | null {
  switch (providerId.trim().toLowerCase()) {
    case "agent-session":
      return "session";
    case "workspace-app":
      return "workspace-app";
    case "workspace-issue":
      return "workspace-issue";
    default:
      return null;
  }
}

function MessageCenterPreviewMentionChip({
  kind,
  label
}: {
  kind: MessageCenterPreviewMentionKind;
  label: string;
}): ReactElement {
  return (
    <span
      className="tsh-agent-object-token tsh-agent-object-token--entity"
      data-agent-mention-kind={kind}
    >
      <span className="tsh-agent-object-token__kind" aria-hidden="true">
        {kind === "workspace-app" ? (
          <AppWindow className="size-3.5" aria-hidden="true" />
        ) : (
          <span
            className="tsh-agent-object-token__kind-icon"
            aria-hidden="true"
          />
        )}
      </span>
      <span className="tsh-agent-object-token__main">{label}</span>
    </span>
  );
}

export function resolveMessageCenterNotificationAction(
  item: WorkspaceAgentMessageCenterItem,
  input: {
    action?: string;
    optionId?: string;
  }
): string | null {
  if (input.action) {
    return normalizeMessageCenterNotificationAction(input.action);
  }

  if (!input.optionId) {
    return null;
  }

  const prompt = item.pendingPrompt;
  const option =
    prompt && "options" in prompt
      ? prompt.options.find((candidate) => candidate.id === input.optionId)
      : null;
  const optionToken = `${option?.kind ?? ""}:${input.optionId}`.toLowerCase();
  if (optionToken.includes("allow") || optionToken.includes("accept")) {
    return "accept";
  }
  if (
    optionToken.includes("deny") ||
    optionToken.includes("reject") ||
    optionToken.includes("disallow")
  ) {
    return "reject";
  }
  return input.optionId;
}

export function buildWorkspaceAgentInteractivePromptLabels(
  t: ReturnType<typeof useTranslation>["t"],
  provider?: string
) {
  return {
    approvalLead: t("agentHost.agentGui.approvalRequired", {
      provider: provider
        ? workspaceAgentProviderLabel(provider)
        : t("agentHost.workspaceAgentsGenericAgentName")
    }),
    planLead: t("agentHost.agentGui.planLead"),
    planModes: [
      {
        id: "acceptEdits",
        label: t("agentHost.agentGui.planModes.acceptEdits.label"),
        description: t("agentHost.agentGui.planModes.acceptEdits.description")
      },
      {
        id: "default",
        label: t("agentHost.agentGui.planModes.askFirst.label"),
        description: t("agentHost.agentGui.planModes.askFirst.description")
      },
      {
        id: "bypassPermissions",
        label: t("agentHost.agentGui.planModes.allowAll.label"),
        description: t("agentHost.agentGui.planModes.allowAll.description")
      },
      {
        id: "auto",
        label: t("agentHost.agentGui.planModes.auto.label"),
        description: t("agentHost.agentGui.planModes.auto.description")
      }
    ],
    stayInPlan: t("agentHost.agentGui.stayInPlan"),
    sendFeedback: t("agentHost.agentGui.sendFeedback"),
    feedbackPlaceholder: t("agentHost.agentGui.feedbackPlaceholder"),
    previousQuestion: t("agentHost.agentGui.previousQuestion"),
    nextQuestion: t("agentHost.agentGui.nextQuestion"),
    submitAnswers: t("agentHost.agentGui.submitAnswers"),
    answerPlaceholder: t("agentHost.agentGui.answerPlaceholder"),
    waitingForAnswer: t("agentHost.agentGui.waitingForAnswer"),
    planImplementationLead: t("agentHost.agentGui.planImplementationLead"),
    planImplementationConfirm: t(
      "agentHost.agentGui.planImplementationConfirm"
    ),
    planImplementationFeedbackPlaceholder: t(
      "agentHost.agentGui.planImplementationFeedbackPlaceholder"
    ),
    planImplementationSend: t("agentHost.agentGui.planImplementationSend"),
    planImplementationSkip: t("agentHost.agentGui.planImplementationSkip")
  };
}

function normalizeMessageCenterNotificationAction(action: string): string {
  switch (action) {
    case "allow":
      return "accept";
    case "deny":
      return "reject";
    default:
      return action;
  }
}
