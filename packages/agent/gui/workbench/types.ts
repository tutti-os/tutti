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
  provider: AgentGuiWorkbenchProvider;
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
