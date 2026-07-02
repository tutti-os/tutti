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
}

export interface AgentGuiWorkbenchWorkspaceState {
  workspaceId: string;
}
