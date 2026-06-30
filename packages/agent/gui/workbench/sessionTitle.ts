import type {
  AgentActivityMessage,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type { UiLanguage } from "../contexts/settings/domain/agentSettings";
import {
  firstAgentGUIUserMessageTitle,
  formatAgentGUIConversationPlainTitle,
  normalizeAgentGUIProviderIdentity,
  resolveAgentGUIExplicitConversationTitle,
  type AgentGUIResolvedProvider
} from "../shared/agentConversationTitleProjection.ts";
import { formatAgentSessionMentionText } from "../shared/utils/agentSessionMentionText.ts";
import type { AgentGuiWorkbenchProvider } from "./types.ts";

export interface AgentGuiSessionTitleFormatOptions {
  fallbackAgentLabel?: string;
  language?: UiLanguage;
}

export interface ResolveAgentGuiWorkbenchSessionTitleInput extends AgentGuiSessionTitleFormatOptions {
  agentSessionId?: string | null;
  fallbackTitle?: string | null;
  provider: AgentGuiWorkbenchProvider | string;
  snapshot: AgentActivitySnapshot;
}

export interface AgentGuiWorkbenchSessionTitleResult {
  agentSessionId: string | null;
  source: "snapshot" | "fallback" | "none";
  title: string | null;
}

export function formatAgentGuiSessionPlainTitle(
  title: string | null | undefined,
  options: AgentGuiSessionTitleFormatOptions = {}
): string {
  return formatAgentSessionMentionText(title, { language: options.language });
}

export function formatAgentGuiConversationPlainTitle(
  conversation: {
    title: string;
    titleFallback?: "generic-agent" | null;
  },
  options: AgentGuiSessionTitleFormatOptions = {}
): string {
  return formatAgentGUIConversationPlainTitle(conversation, options);
}

export function resolveAgentGuiWorkbenchSessionTitle({
  agentSessionId,
  fallbackTitle,
  language,
  provider,
  snapshot
}: ResolveAgentGuiWorkbenchSessionTitleInput): AgentGuiWorkbenchSessionTitleResult {
  const normalizedAgentSessionId = agentSessionId?.trim() ?? "";
  if (!normalizedAgentSessionId) {
    return { agentSessionId: null, source: "none", title: null };
  }

  const session = snapshot.sessions.find(
    (item) => item.agentSessionId === normalizedAgentSessionId
  );
  const sessionMessages =
    snapshot.sessionMessagesById[normalizedAgentSessionId] ?? [];
  const normalizedProvider = normalizeAgentGUIProviderIdentity(
    session?.provider ?? provider
  );
  const snapshotTitle = resolveDisplayableSnapshotSessionTitle({
    messages: sessionMessages,
    provider: normalizedProvider,
    sessionTitle: session?.title ?? "",
    language
  });
  if (snapshotTitle) {
    return {
      agentSessionId: normalizedAgentSessionId,
      source: "snapshot",
      title: snapshotTitle
    };
  }

  if (session || sessionMessages.length > 0) {
    return {
      agentSessionId: normalizedAgentSessionId,
      source: "none",
      title: null
    };
  }

  const fallbackDisplayTitle = formatAgentGuiConversationPlainTitle(
    { title: fallbackTitle ?? "", titleFallback: null },
    { language }
  );
  return fallbackDisplayTitle
    ? {
        agentSessionId: normalizedAgentSessionId,
        source: "fallback",
        title: fallbackDisplayTitle
      }
    : {
        agentSessionId: normalizedAgentSessionId,
        source: "none",
        title: null
      };
}

function resolveDisplayableSnapshotSessionTitle(input: {
  messages: readonly AgentActivityMessage[];
  provider: AgentGUIResolvedProvider;
  sessionTitle: string;
  language?: UiLanguage;
}): string {
  const explicitSessionTitle = explicitConversationTitle({
    language: input.language,
    provider: input.provider,
    title: input.sessionTitle
  });
  if (explicitSessionTitle) {
    return explicitSessionTitle;
  }
  return explicitConversationTitle({
    language: input.language,
    provider: input.provider,
    title: firstAgentGUIUserMessageTitle(input.messages)
  });
}

function explicitConversationTitle(input: {
  language?: UiLanguage;
  provider: AgentGUIResolvedProvider;
  title: string | null | undefined;
}): string {
  return (
    resolveAgentGUIExplicitConversationTitle({
      provider: input.provider,
      title: formatAgentGuiConversationPlainTitle(
        { title: input.title ?? "", titleFallback: null },
        { language: input.language }
      ),
      titleFallback: null
    }) ?? ""
  );
}
