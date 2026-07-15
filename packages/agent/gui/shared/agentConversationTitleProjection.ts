import { AGENT_PROVIDER_LABEL } from "../contexts/settings/domain/agentSettings.providerMeta.ts";
import { translateInUiLanguage } from "../i18n/runtime.ts";
import { resolveAgentGUIProviderCatalogIdentity } from "../providerIdentityCatalog.ts";
import type { AgentGUIProvider } from "../types.ts";
import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes.ts";

export type AgentGUIResolvedProvider = AgentGUIProvider | "unknown";
export type AgentGUIConversationTitleFallback = "generic-agent" | null;

const AGENT_GUI_UNRESOLVED_PROVIDER: AgentGUIResolvedProvider = "unknown";

export function isAgentGUIProviderUnresolved(
  value: AgentGUIResolvedProvider
): value is "unknown" {
  return value === AGENT_GUI_UNRESOLVED_PROVIDER;
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
  title: string | null | undefined,
  provider: AgentGUIResolvedProvider
): {
  title: string;
  titleFallback: AgentGUIConversationTitleFallback;
} {
  const normalizedTitle = title?.trim() ?? "";
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
    title: providerLabel(provider),
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
    return input.title.trim();
  }
  if (input.titleFallback === "generic-agent") {
    return stripAgentGUITitleTrailingPeriod(fallbackAgentLabel);
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

  const title = input.title.trim();
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
