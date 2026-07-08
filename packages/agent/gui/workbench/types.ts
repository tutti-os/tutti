import type { AgentGUIProviderTargetRef } from "../types";

export type AgentGuiWorkbenchProvider =
  | "claude-code"
  | "codex"
  | "tutti-agent"
  | "cursor"
  | "nexight"
  | "hermes"
  | "openclaw"
  | "opencode";

export const agentGuiWorkbenchOpenSessionActivationType =
  "agent-gui:open-session";

export const agentGuiWorkbenchPrefillPromptActivationType =
  "agent-gui:prefill-prompt";

export interface AgentGuiWorkbenchPrefillPromptPayload {
  agentTargetId?: string | null;
  autoSubmit?: boolean;
  draftPrompt: string;
  provider?: AgentGuiWorkbenchProvider;
  userProjectPath?: string | null;
}

export interface AgentGuiWorkbenchComposerOverrides {
  model?: string | null;
  permissionModeId?: string | null;
  planMode?: boolean;
  reasoningEffort?: string | null;
  speed?: string | null;
}

export type AgentGuiWorkbenchComposerOverridesByProvider = Partial<
  Record<AgentGuiWorkbenchProvider, AgentGuiWorkbenchComposerOverrides | null>
>;

export type AgentGuiWorkbenchComposerOverridesByAgentTargetId = Record<
  string,
  AgentGuiWorkbenchComposerOverrides | null
>;

export interface AgentGuiWorkbenchNodeState {
  agentTargetId?: string | null;
  composerOverrides?: AgentGuiWorkbenchComposerOverrides | null;
  composerOverridesByAgentTargetId?: AgentGuiWorkbenchComposerOverridesByAgentTargetId | null;
  composerOverridesByProvider?: AgentGuiWorkbenchComposerOverridesByProvider | null;
  conversationCount?: number | null;
  conversationRailCollapsed?: boolean | null;
  conversationRailWidthPx?: number | null;
  lastActiveAgentSessionId: string | null;
  /** @deprecated Conversation titles are derived from the active session id. */
  lastActiveConversationTitle?: string | null;
  provider: AgentGuiWorkbenchProvider;
  /** @deprecated Use agentTargetId for selection restore. */
  providerTargetId?: string | null;
  /** @deprecated Provider target refs are resolved from the current target list. */
  providerTargetRef?: AgentGUIProviderTargetRef | null;
}

export interface AgentGuiWorkbenchState {
  agentTargetId?: string | null;
  conversationRailCollapsed?: boolean | null;
  conversationRailWidthPx?: number | null;
  lastActiveAgentSessionId: string | null;
  lastActiveConversationTitle?: string | null;
}

export interface AgentGuiWorkbenchWorkspaceState {
  workspaceId: string;
}
