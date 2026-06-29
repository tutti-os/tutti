import type { AgentGUIProviderTargetRef } from "../types";

export type AgentGuiWorkbenchProvider =
  | "claude-code"
  | "codex"
  | "nexight"
  | "gemini"
  | "hermes"
  | "openclaw";

export const agentGuiWorkbenchOpenSessionActivationType =
  "agent-gui:open-session";

export const agentGuiWorkbenchPrefillPromptActivationType =
  "agent-gui:prefill-prompt";

export interface AgentGuiWorkbenchPrefillPromptPayload {
  autoSubmit?: boolean;
  draftPrompt: string;
  userProjectPath?: string | null;
}

export interface AgentGuiWorkbenchComposerOverrides {
  model?: string | null;
  permissionModeId?: string | null;
  planMode?: boolean;
  reasoningEffort?: string | null;
}

export type AgentGuiWorkbenchComposerOverridesByProvider = Partial<
  Record<AgentGuiWorkbenchProvider, AgentGuiWorkbenchComposerOverrides | null>
>;

export interface AgentGuiWorkbenchNodeState {
  composerOverrides?: AgentGuiWorkbenchComposerOverrides | null;
  composerOverridesByProvider?: AgentGuiWorkbenchComposerOverridesByProvider | null;
  conversationCount?: number | null;
  conversationRailCollapsed?: boolean | null;
  conversationRailWidthPx?: number | null;
  lastActiveAgentSessionId: string | null;
  /** @deprecated Conversation titles are derived from the active session id. */
  lastActiveConversationTitle?: string | null;
  provider: AgentGuiWorkbenchProvider;
  providerTargetId?: string | null;
  providerTargetRef?: AgentGUIProviderTargetRef | null;
}

export interface AgentGuiWorkbenchState {
  composerOverrides?: AgentGuiWorkbenchComposerOverrides | null;
  composerOverridesByProvider?: AgentGuiWorkbenchComposerOverridesByProvider | null;
  conversationRailCollapsed?: boolean | null;
  conversationRailWidthPx?: number | null;
  lastActiveAgentSessionId: string | null;
  /** @deprecated Conversation titles are derived from the active session id. */
  lastActiveConversationTitle?: string | null;
  providerTargetId?: string | null;
  providerTargetRef?: AgentGUIProviderTargetRef | null;
}

export interface AgentGuiWorkbenchWorkspaceState {
  workspaceId: string;
}
