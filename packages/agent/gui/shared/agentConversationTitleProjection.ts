import { AGENT_PROVIDER_LABEL } from "../contexts/settings/domain/agentSettings.providerMeta.ts";
import { translateInUiLanguage } from "../i18n/runtime.ts";
import { resolveAgentGUIProviderCatalogIdentity } from "../providerIdentityCatalog.ts";
import type { AgentGUIProvider } from "../types.ts";
import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes.ts";
import { normalizeAgentTitleText } from "./utils/agentTitleText.ts";

export type AgentGUIResolvedProvider = AgentGUIProvider | "unknown";
export type AgentGUIConversationTitleFallback = "untitled-conversation" | null;

const AGENT_GUI_UNRESOLVED_PROVIDER: AgentGUIResolvedProvider = "unknown";
const AGENT_GUI_MAX_OPTIMISTIC_TITLE_CODE_POINTS = 120;
const AGENT_GUI_TRUNCATED_TITLE_SUFFIX = "...";

export function isAgentGUIProviderUnresolved(
  value: AgentGUIResolvedProvider
): value is "unknown" {
  return value === AGENT_GUI_UNRESOLVED_PROVIDER;
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
  const normalized = provider?.trim().toLowerCase() ?? "";
  const catalogIdentity = resolveAgentGUIProviderCatalogIdentity(normalized);
  if (catalogIdentity) {
    return catalogIdentity.providerId as AgentGUIProvider;
  }
  if (!/^[a-z][a-z0-9._:-]{0,127}$/.test(normalized)) {
    return "unknown";
  }
  return normalized as AgentGUIProvider;
}

function providerLabel(provider: AgentGUIProvider): string {
  return (AGENT_PROVIDER_LABEL as Record<string, string>)[provider] ?? provider;
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
  title: string | null | undefined
): {
  title: string;
  titleFallback: AgentGUIConversationTitleFallback;
} {
  const normalizedTitle = stripAgentGUITitleTrailingPeriod(title?.trim() ?? "");
  if (normalizedTitle) {
    return {
      title: normalizedTitle,
      titleFallback: null
    };
  }
  return {
    title: "",
    titleFallback: "untitled-conversation"
  };
}

export function deriveAgentGUIOptimisticConversationTitle(
  visiblePrompt: string | null | undefined
): string {
  const normalizedTitle = normalizeAgentTitleText(visiblePrompt);
  const codePoints = Array.from(normalizedTitle);
  if (codePoints.length <= AGENT_GUI_MAX_OPTIMISTIC_TITLE_CODE_POINTS) {
    return normalizedTitle;
  }
  return `${codePoints
    .slice(
      0,
      AGENT_GUI_MAX_OPTIMISTIC_TITLE_CODE_POINTS -
        AGENT_GUI_TRUNCATED_TITLE_SUFFIX.length
    )
    .join("")
    .trimEnd()}${AGENT_GUI_TRUNCATED_TITLE_SUFFIX}`;
}

export function resolveAgentGUIConversationDisplayTitle(
  input: {
    title: string;
    titleFallback?: AgentGUIConversationTitleFallback;
  },
  untitledConversationLabel: string
): string {
  if (input.title) {
    return stripAgentGUITitleTrailingPeriod(input.title.trim());
  }
  if (input.titleFallback === "untitled-conversation") {
    return stripAgentGUITitleTrailingPeriod(untitledConversationLabel);
  }
  return "";
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

  const title = stripAgentGUITitleTrailingPeriod(input.title.trim());
  if (!title) {
    return null;
  }
  if (isAgentGUIUntitledTaskTitle(title)) {
    return null;
  }

  if (input.provider !== "unknown" && title === providerLabel(input.provider)) {
    return null;
  }

  return title;
}

export function resolveAgentGUIExplicitConversationTitleFromMessages(input: {
  messages: readonly AgentGUIConversationTitleMessage[];
  provider: AgentGUIResolvedProvider;
  title: string | null | undefined;
}): string | null {
  const explicitTitle = resolveAgentGUIExplicitConversationTitle({
    provider: input.provider,
    title: input.title?.trim() ?? ""
  });
  if (explicitTitle) {
    return explicitTitle;
  }
  return resolveAgentGUIExplicitConversationTitle({
    provider: input.provider,
    title: firstAgentGUIUserMessageTitle(input.messages)
  });
}

export function resolveAgentGUIProviderDisplayLabel(
  provider: string | null | undefined,
  fallbackAgentLabel: string
): string {
  const resolvedProvider = normalizeAgentGUIProviderIdentity(provider);
  if (resolvedProvider === "unknown") {
    return fallbackAgentLabel;
  }
  return providerLabel(resolvedProvider);
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
            "agentHost.workspaceAgentsUntitledConversation"
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
