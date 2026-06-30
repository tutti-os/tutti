import { AGENT_PROVIDER_LABEL } from "../contexts/settings/domain/agentSettings.providerMeta.ts";
import type { UiLanguage } from "../contexts/settings/domain/agentSettings.ts";
import { translateInUiLanguage } from "../i18n/runtime.ts";
import type { AgentGUIProvider } from "../types.ts";
import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentActivityTypes.ts";
import { formatAgentSessionMentionText } from "./utils/agentSessionMentionText.ts";
import { normalizeAgentTitleText } from "./utils/agentTitleText.ts";

export type AgentGUIResolvedProvider = AgentGUIProvider | "unknown";
export type AgentGUIConversationTitleFallback = "generic-agent" | null;

export interface AgentGUIConversationPlainTitleOptions {
  fallbackAgentLabel?: string;
  language?: UiLanguage;
}

export interface AgentGUIConversationTitleMessage {
  id?: number | string | null;
  messageId?: string | null;
  version?: number | null;
  role?: string | null;
  kind?: string | null;
  payload?: {
    content?: unknown;
    displayPrompt?: unknown;
    text?: unknown;
  } | null;
  occurredAtUnixMs?: number | null;
  completedAtUnixMs?: number | null;
  startedAtUnixMs?: number | null;
}

export function normalizeAgentGUIProviderIdentity(
  provider: string | null | undefined
): AgentGUIResolvedProvider {
  switch (provider?.trim().toLowerCase() ?? "") {
    case "claude-code":
    case "claude":
    case "claude code":
      return "claude-code";
    case "codex":
      return "codex";
    case "nexight":
    case "tutti":
      return "nexight";
    case "gemini":
      return "gemini";
    case "hermes":
      return "hermes";
    case "openclaw":
      return "openclaw";
    default:
      return "unknown";
  }
}

export function resolveAgentGUIProviderIdentity(input: {
  sessionProvider?: string | null;
  workspaceSessionProvider?: string | null;
  conversationProvider?: string | null;
  timelineItems?: readonly WorkspaceAgentActivityTimelineItem[];
}): AgentGUIResolvedProvider {
  const candidates = [
    input.sessionProvider,
    input.workspaceSessionProvider,
    input.conversationProvider,
    timelineProviderHint(input.timelineItems ?? [])
  ];
  for (const candidate of candidates) {
    const normalized = normalizeAgentGUIProviderIdentity(candidate);
    if (normalized !== "unknown") {
      return normalized;
    }
  }
  return "unknown";
}

export function resolveAgentGUIConversationTitle(
  title: string | null | undefined,
  provider: AgentGUIResolvedProvider
): {
  title: string;
  titleFallback: AgentGUIConversationTitleFallback;
} {
  const normalizedTitle = stripAgentGUITitleTrailingPeriod(
    normalizeAgentTitleText(title)
  );
  if (normalizedTitle) {
    return {
      title: normalizedTitle,
      titleFallback: null
    };
  }
  if (provider === "unknown") {
    return {
      title: "",
      titleFallback: "generic-agent"
    };
  }
  return {
    title: AGENT_PROVIDER_LABEL[provider],
    titleFallback: null
  };
}

export function resolveAgentGUIConversationDisplayTitle(
  input: {
    title: string;
    titleFallback?: AgentGUIConversationTitleFallback;
  },
  fallbackAgentLabel: string
): string {
  if (input.title) {
    return stripAgentGUITitleTrailingPeriod(
      normalizeAgentTitleText(input.title)
    );
  }
  if (input.titleFallback === "generic-agent") {
    return stripAgentGUITitleTrailingPeriod(fallbackAgentLabel);
  }
  return "";
}

export function formatAgentGUIConversationPlainTitle(
  input: {
    title: string;
    titleFallback?: AgentGUIConversationTitleFallback;
  },
  options: AgentGUIConversationPlainTitleOptions = {}
): string {
  return formatAgentSessionMentionText(
    resolveAgentGUIConversationDisplayTitle(
      input,
      options.fallbackAgentLabel ?? "Agent"
    ),
    {
      language: options.language
    }
  );
}

export function resolveAgentGUIDockConversationTitle(input: {
  provider: AgentGUIResolvedProvider;
  title: string;
  titleFallback?: AgentGUIConversationTitleFallback;
}): string | null {
  return resolveAgentGUIExplicitConversationTitle(input);
}

export function resolveAgentGUIExplicitConversationTitle(input: {
  provider: AgentGUIResolvedProvider;
  title: string;
  titleFallback?: AgentGUIConversationTitleFallback;
}): string | null {
  if (input.titleFallback) {
    return null;
  }

  const title = stripAgentGUITitleTrailingPeriod(
    normalizeAgentTitleText(input.title)
  );
  if (!title) {
    return null;
  }
  if (isAgentGUIUntitledTaskTitle(title)) {
    return null;
  }

  if (
    input.provider !== "unknown" &&
    title === AGENT_PROVIDER_LABEL[input.provider]
  ) {
    return null;
  }

  return title;
}

export function resolveAgentGUIProviderDisplayLabel(
  provider: string | null | undefined,
  fallbackAgentLabel: string
): string {
  const resolvedProvider = normalizeAgentGUIProviderIdentity(provider);
  if (resolvedProvider === "unknown") {
    return fallbackAgentLabel;
  }
  return AGENT_PROVIDER_LABEL[resolvedProvider];
}

export function firstAgentGUIUserMessageTitle(
  messages: readonly AgentGUIConversationTitleMessage[]
): string {
  const userMessage = [...messages]
    .filter(
      (message) =>
        messageRole(message) === "user" && messageText(message).length > 0
    )
    .sort(compareMessagesAscending)[0];
  return userMessage ? messageText(userMessage) : "";
}

function messageRole(
  message: AgentGUIConversationTitleMessage
): "user" | "agent" | null {
  const role = message.role?.trim().toLowerCase();
  if (role === "user") {
    return "user";
  }
  if (role === "assistant" || role === "agent") {
    return "agent";
  }
  const kind = message.kind?.trim().toLowerCase() ?? "";
  if (kind === "message.user") {
    return "user";
  }
  if (kind === "message.assistant" || kind === "message.agent") {
    return "agent";
  }
  return null;
}

function messageText(message: AgentGUIConversationTitleMessage): string {
  const payload = message.payload;
  const displayPrompt =
    typeof payload?.displayPrompt === "string" ? payload.displayPrompt : "";
  const text = typeof payload?.text === "string" ? payload.text : "";
  const content = typeof payload?.content === "string" ? payload.content : "";
  return normalizeAgentTitleText(displayPrompt || text || content);
}

function compareMessagesAscending(
  left: AgentGUIConversationTitleMessage,
  right: AgentGUIConversationTitleMessage
): number {
  const leftTime =
    left.occurredAtUnixMs ??
    left.completedAtUnixMs ??
    left.startedAtUnixMs ??
    0;
  const rightTime =
    right.occurredAtUnixMs ??
    right.completedAtUnixMs ??
    right.startedAtUnixMs ??
    0;
  const timeDiff = leftTime - rightTime;
  if (timeDiff !== 0) {
    return timeDiff;
  }
  const sequenceDiff =
    messageSequence(left) - messageSequence(right) ||
    (left.messageId ?? "").localeCompare(right.messageId ?? "");
  return sequenceDiff;
}

function messageSequence(message: AgentGUIConversationTitleMessage): number {
  const numericId =
    typeof message.id === "number" && Number.isFinite(message.id)
      ? message.id
      : 0;
  return message.version ?? numericId;
}

function stripAgentGUITitleTrailingPeriod(title: string): string {
  return title
    .trimEnd()
    .replace(/[.。]+$/u, "")
    .trimEnd();
}

function isAgentGUIUntitledTaskTitle(title: string): boolean {
  return localizedAgentGUIUntitledTaskLabels().has(compactTitleText(title));
}

function localizedAgentGUIUntitledTaskLabels(): Set<string> {
  return new Set(
    (["en", "zh-CN"] as const)
      .map((language) =>
        compactTitleText(
          translateInUiLanguage(
            language,
            "agentHost.workspaceAgentsUntitledTask"
          )
        )
      )
      .filter(Boolean)
  );
}

function timelineProviderHint(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): string | null {
  for (const item of timelineItems) {
    if (isUserTimelineItem(item)) {
      continue;
    }
    const normalized = normalizeAgentGUIProviderIdentity(item.actorId);
    if (normalized !== "unknown") {
      return normalized;
    }
  }
  return null;
}

function isUserTimelineItem(item: WorkspaceAgentActivityTimelineItem): boolean {
  const role = item.role?.trim().toLowerCase();
  if (role === "user") {
    return true;
  }
  const actorType = item.actorType.trim().toLowerCase();
  if (actorType === "user") {
    return true;
  }
  return item.itemType.trim().toLowerCase() === "message.user";
}

function compactTitleText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
