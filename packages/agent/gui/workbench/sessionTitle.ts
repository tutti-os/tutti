import type { AgentActivitySession } from "@tutti-os/agent-activity-core";
import { resolveAgentGUIProviderDisplayLabel } from "../shared/agentConversationTitleProjection.ts";
import type { AgentGuiWorkbenchProvider } from "./types.ts";

export interface ResolveAgentGuiWorkbenchHeaderTitleInput {
  agentName?: string | null;
  conversationTitle?: string | null;
  provider?: string | null;
}

export interface ResolveAgentGuiWorkbenchSessionTitleInput {
  agentSessionId?: string | null;
  fallbackTitle?: string | null;
  provider: AgentGuiWorkbenchProvider | string;
  session?: Pick<AgentActivitySession, "title"> | null;
}

export interface AgentGuiWorkbenchSessionTitleResult {
  agentSessionId: string | null;
  source: "snapshot" | "fallback" | "none";
  title: string | null;
}

export function resolveAgentGuiWorkbenchHeaderTitle({
  agentName,
  conversationTitle,
  provider
}: ResolveAgentGuiWorkbenchHeaderTitleInput): string | null {
  return (
    stripTitle(agentName) ||
    stripTitle(resolveAgentGUIProviderDisplayLabel(provider, "")) ||
    stripTitle(conversationTitle) ||
    null
  );
}

export function resolveAgentGuiWorkbenchSessionTitle({
  agentSessionId,
  fallbackTitle,
  session = null
}: ResolveAgentGuiWorkbenchSessionTitleInput): AgentGuiWorkbenchSessionTitleResult {
  const normalizedAgentSessionId = agentSessionId?.trim() ?? "";
  if (!normalizedAgentSessionId) {
    return { agentSessionId: null, source: "none", title: null };
  }

  const snapshotTitle = stripTitle(session?.title);
  if (snapshotTitle) {
    return {
      agentSessionId: normalizedAgentSessionId,
      source: "snapshot",
      title: snapshotTitle
    };
  }

  if (session) {
    return {
      agentSessionId: normalizedAgentSessionId,
      source: "none",
      title: null
    };
  }

  const fallbackDisplayTitle = stripTitle(fallbackTitle);
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

function stripTitle(value: string | null | undefined): string {
  return value?.trim() ?? "";
}
