import {
  isPendingActivationViable,
  selectLatestActivationForSession,
  selectSessionMessages,
  selectWorkspaceAgentConsumerSession,
  type AgentActivityMessage,
  type AgentPromptContentBlock,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import { resolveAgentGuiSessionProviderIconUrl } from "../agentGuiSessionProviderIconUrls.ts";
import {
  resolveAgentGUIConversationBrowserFreeTitle,
  resolveAgentGUIConversationTitleDisplayPrompt
} from "../shared/agentConversationTitleProjection.ts";
import type { AgentGUIAgent } from "../types.ts";
import { isAgentGuiWorkbenchProvider } from "./providerCatalog.ts";
import {
  resolveAgentGuiWorkbenchHeaderTitle,
  resolveAgentGuiWorkbenchSessionTitle
} from "./sessionTitle.ts";
import type {
  AgentGuiWorkbenchProvider,
  AgentGuiWorkbenchState
} from "./types.ts";

export interface AgentGuiWorkbenchConversationIdentity {
  agentTitle?: string | null;
  iconUrl?: string | null;
  title: string | null;
  titleDisplayPrompt?: string | null;
}

export function resolveAgentGuiWorkbenchConversationIdentity(input: {
  agents: readonly AgentGUIAgent[];
  dockIconUrls?: Partial<Record<AgentGuiWorkbenchProvider, string>>;
  engineState: AgentSessionEngineState;
  workbenchState: AgentGuiWorkbenchState | null;
}): AgentGuiWorkbenchConversationIdentity | null {
  const agentSessionId =
    input.workbenchState?.lastActiveAgentSessionId?.trim() ?? "";
  if (!agentSessionId) {
    return null;
  }

  const session = selectWorkspaceAgentConsumerSession(
    input.engineState,
    agentSessionId
  )?.session;
  const activation = selectLatestActivationForSession(
    input.engineState,
    agentSessionId
  );
  const optimisticTitle =
    activation?.mode === "new" && isPendingActivationViable(activation)
      ? activation.optimisticTitle
      : null;
  const agentTargetId =
    session?.agentTargetId ?? input.workbenchState?.agentTargetId ?? null;
  const agent = agentTargetId
    ? (input.agents.find(
        (candidate) => candidate.agentTargetId === agentTargetId
      ) ?? null)
    : null;
  const provider = session?.provider ?? agent?.provider ?? null;
  const resolvedTitle = resolveAgentGuiWorkbenchSessionTitle({
    agentSessionId,
    fallbackTitle: null,
    optimisticTitle,
    session
  });
  const canonicalTitle = resolvedTitle.title;
  const messages = selectSessionMessages(input.engineState, agentSessionId);
  const titleDisplayPrompt = resolveAgentGuiWorkbenchTitleDisplayPrompt({
    activation,
    allowEmptyTitle: resolvedTitle.source === "optimistic",
    messages,
    title: canonicalTitle
  });
  // Keep browser context canonical in the message while omitting its tag from the visible header title.
  const title = resolveAgentGUIConversationBrowserFreeTitle({
    activation,
    allowEmptyTitle: resolvedTitle.source === "optimistic",
    messages,
    title: canonicalTitle
  });
  const agentTitle = resolveAgentGuiWorkbenchHeaderTitle({
    agentName: agent?.name,
    conversationTitle: title,
    provider
  });
  const iconUrl =
    agent?.iconUrl ??
    resolveAgentGuiSessionProviderIconUrl(provider ?? undefined) ??
    (isAgentGuiWorkbenchProvider(provider)
      ? (input.dockIconUrls?.[provider] ?? null)
      : null);

  return {
    agentTitle,
    iconUrl,
    title,
    titleDisplayPrompt
  };
}

export function resolveAgentGuiWorkbenchTitleDisplayPrompt(input: {
  activation?: {
    content: readonly AgentPromptContentBlock[];
    displayPrompt?: string;
    mode: "existing" | "new";
    status: import("@tutti-os/agent-activity-core").PendingActivationStatus;
  } | null;
  allowEmptyTitle?: boolean;
  messages: readonly AgentActivityMessage[];
  title: string | null;
}): string | null {
  return resolveAgentGUIConversationTitleDisplayPrompt(input);
}

export function agentGuiWorkbenchConversationIdentitiesEqual(
  left: AgentGuiWorkbenchConversationIdentity | null,
  right: AgentGuiWorkbenchConversationIdentity | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.agentTitle === right.agentTitle &&
      left.iconUrl === right.iconUrl &&
      left.title === right.title &&
      left.titleDisplayPrompt === right.titleDisplayPrompt)
  );
}
