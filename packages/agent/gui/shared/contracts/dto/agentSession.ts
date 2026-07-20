export type AgentHostAgentSessionProvider =
  | "claude-code"
  | "codex"
  | "tutti-agent"
  | "cursor"
  | "nexight"
  | "hermes"
  | "opencode"
  | "openclaw";
export type AgentHostAgentSessionPermissionModeSemantic =
  | "ask-before-write"
  | "accept-edits"
  | "locked-down"
  | "auto"
  | "full-access"
  | "unconfigurable";
export type AgentHostAgentSessionPermissionMode = string;
export type AgentHostAgentSessionReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | string;
export type AgentHostAgentSessionSpeed = "standard" | "fast" | string;

export interface AgentHostAgentSessionPermissionModeOption {
  id: string;
  label?: string;
  description?: string;
  semantic: AgentHostAgentSessionPermissionModeSemantic;
}

export interface AgentHostAgentSessionPermissionConfig {
  configurable: boolean;
  defaultValue?: string | null;
  modes: AgentHostAgentSessionPermissionModeOption[];
}

export interface AgentHostAgentSessionComposerSettings {
  model?: string | null;
  reasoningEffort?: AgentHostAgentSessionReasoningEffort | null;
  speed?: AgentHostAgentSessionSpeed | null;
  planMode?: boolean;
  browserUse?: boolean;
  computerUse?: boolean;
  permissionModeId?: string | null;
}

export interface AgentHostAgentSessionEvent {
  id: string;
  workspaceId: string;
  agentSessionId: string;
  agentTargetId?: string | null;
  provider: AgentHostAgentSessionProvider;
  providerSessionId?: string;
  type: string;
  turnId?: string;
  role?: "user" | "assistant" | string;
  content?: string;
  status?: string;
  payload?: Record<string, unknown>;
  occurredAtUnixMs: number;
}

export interface AgentHostAgentSessionInteractivePrompt {
  kind: string;
  requestId?: string;
  toolName?: string;
  status?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AgentHostAgentSessionState {
  workspaceId: string;
  agentSessionId: string;
  agentTargetId?: string | null;
  provider: AgentHostAgentSessionProvider;
  providerSessionId?: string;
  resumable?: boolean;
  permissionModeId?: string;
  permissionConfig?: AgentHostAgentSessionPermissionConfig;
  settings?: AgentHostAgentSessionComposerSettings;
  authState?: string;
  pinnedAtUnixMs?: number | null;
  updatedAtUnixMs: number;
}
export interface AgentHostUnactivateAgentSessionInput {
  workspaceId?: string | null;
  agentSessionId: string;
}

export interface AgentHostUnactivateAgentSessionResult {
  agentSessionId: string;
  buffered: boolean;
}

export interface AgentHostExecAgentSessionInput {
  workspaceId?: string | null;
  agentSessionId: string;
  content: AgentPromptContentBlock[];
}

export interface AgentPromptContentBlock {
  type: "text" | "image" | "file" | "skill" | "mention";
  text?: string;
  mimeType?: "image/png" | "image/jpeg" | "image/webp" | string;
  data?: string;
  url?: string;
  attachmentId?: string;
  name?: string;
  path?: string;
  uri?: string;
  hostPath?: string;
  uploadStatus?: string;
  assetId?: string;
  kind?: string;
  sizeBytes?: number;
}

export interface AgentHostExecAgentSessionResult {
  agentSessionId: string;
  status?: "started" | string;
  turnId?: string;
  accepted: boolean;
  sessionStatus: string;
}

export interface AgentHostCancelAgentSessionInput {
  workspaceId?: string | null;
  agentSessionId: string;
  reason?: string;
}

export interface AgentHostCancelAgentSessionResult {
  agentSessionId: string;
  canceled: boolean;
  reason?:
    | "active_turn_canceled"
    | "no_active_turn"
    | "stale_turn_reconciled"
    | (string & {});
  sessionStatus?: string;
}

export interface AgentHostRespondAgentSessionPermissionInput {
  workspaceId?: string | null;
  agentSessionId: string;
  requestId: string;
  optionId: string;
}

export interface AgentHostRespondAgentSessionPermissionResult {
  agentSessionId: string;
  requestId: string;
  accepted: boolean;
}

export interface AgentHostUpdateAgentSessionSettingsInput {
  workspaceId?: string | null;
  agentSessionId: string;
  settings: AgentHostAgentSessionComposerSettings;
}

export interface AgentHostUpdateAgentSessionSettingsResult {
  agentSessionId: string;
  settings: AgentHostAgentSessionComposerSettings;
}

export interface AgentHostGetAgentSessionStateInput {
  workspaceId?: string | null;
  agentSessionId: string;
}

export type AgentHostGetAgentSessionStateResult = AgentHostAgentSessionState;

export interface AgentHostSubmitAgentSessionInteractiveInput {
  workspaceId?: string | null;
  agentSessionId: string;
  requestId: string;
  turnId: string;
  action?: string;
  optionId?: string;
  payload?: Record<string, unknown>;
}

export interface AgentHostSubmitAgentSessionInteractiveResult {
  agentSessionId: string;
  requestId: string;
  accepted: boolean;
  events: AgentHostAgentSessionEvent[];
}

export interface AgentHostSubscribeAgentSessionEventsInput {
  workspaceId?: string | null;
  agentSessionId: string;
}

export type AgentHostRetainAgentSessionEventStreamInput =
  AgentHostSubscribeAgentSessionEventsInput;

export interface AgentHostReleaseAgentSessionEventStreamInput {
  leaseId: string;
}

export interface AgentHostAgentSessionCommand {
  name: string;
  description?: string;
  inputHint?: string;
}

export interface AgentHostAgentSessionEventsSubscription {
  subscriptionId: string;
  subscribed: boolean;
}

export interface AgentHostAgentSessionEventStreamLease {
  leaseId: string;
  retained: boolean;
}
