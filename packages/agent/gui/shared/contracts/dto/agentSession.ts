import type { AgentHostWorkspaceAgentStatePatch } from "./agentHost";

export type AgentHostAgentSessionProvider =
  | "claude-code"
  | "codex"
  | "nexight"
  | "gemini"
  | "hermes"
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
  planMode?: boolean;
  permissionModeId?: string | null;
}

export interface AgentHostAgentSession {
  workspaceId: string;
  agentSessionId: string;
  provider: AgentHostAgentSessionProvider;
  providerSessionId: string;
  resumable?: boolean;
  cwd?: string;
  status: "ready" | "working" | "canceled" | "failed" | "completed" | string;
  title?: string;
  pinnedAtUnixMs?: number | null;
  visible?: boolean;
  permissionModeId?: string;
  permissionConfig?: AgentHostAgentSessionPermissionConfig;
  settings?: AgentHostAgentSessionComposerSettings;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export interface AgentHostAgentSessionEvent {
  id: string;
  workspaceId: string;
  agentSessionId: string;
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
  provider: AgentHostAgentSessionProvider;
  providerSessionId?: string;
  resumable?: boolean;
  status: AgentHostAgentSession["status"];
  permissionModeId?: string;
  permissionConfig?: AgentHostAgentSessionPermissionConfig;
  settings?: AgentHostAgentSessionComposerSettings;
  authState?: string;
  runtimeContext?: Record<string, unknown>;
  pinnedAtUnixMs?: number | null;
  pendingInteractive?: AgentHostAgentSessionInteractivePrompt | null;
  updatedAtUnixMs: number;
}
export type AgentHostAgentSessionActivationMode = "new" | "existing";
export type AgentHostAgentSessionActivationStatus =
  | "attached"
  | "already_attached"
  | "failed";

interface AgentHostActivateAgentSessionInputBase {
  workspaceId?: string | null;
  agentSessionId: string;
  /**
   * Controls whether this runtime session is visible to room-level agent activity surfaces.
   * Hidden sessions still publish live session events to direct subscribers, but are not
   * projected into workspaceAgents.list and are not reported upstream.
   */
  visible?: boolean;
}

export interface AgentHostActivateNewAgentSessionInput extends AgentHostActivateAgentSessionInputBase {
  mode: "new";
  provider: AgentHostAgentSessionProvider;
  cwd: string;
  title: string;
  settings: AgentHostAgentSessionComposerSettings;
  openclawGatewayReady?: boolean;
}

export interface AgentHostActivateExistingAgentSessionInput extends AgentHostActivateAgentSessionInputBase {
  mode: "existing";
  provider?: never;
  cwd?: never;
  title?: never;
  settings?: never;
}

export type AgentHostActivateAgentSessionInput =
  | AgentHostActivateNewAgentSessionInput
  | AgentHostActivateExistingAgentSessionInput;

export interface AgentHostActivateAgentSessionResult {
  session: AgentHostAgentSession;
  activation: {
    mode: AgentHostAgentSessionActivationMode;
    status: AgentHostAgentSessionActivationStatus;
  };
  error?: {
    code: string;
    message: string;
    debugMessage?: string;
  };
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
  type: "text" | "image";
  text?: string;
  mimeType?: "image/png" | "image/jpeg" | "image/webp";
  data?: string;
  attachmentId?: string;
  name?: string;
}

export interface AgentHostExecAgentSessionResult {
  agentSessionId: string;
  status?: "started" | string;
  turnId?: string;
  accepted: boolean;
  sessionStatus: AgentHostAgentSession["status"];
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
  sessionStatus?: AgentHostAgentSession["status"];
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

export interface AgentHostPinAgentSessionInput {
  workspaceId?: string | null;
  agentSessionId: string;
  pinned: boolean;
}

export type AgentHostPinAgentSessionResult = AgentHostAgentSession;

export interface AgentHostGetAgentSessionStateInput {
  workspaceId?: string | null;
  agentSessionId: string;
}

export type AgentHostGetAgentSessionStateResult = AgentHostAgentSessionState;

export interface AgentHostSubmitAgentSessionInteractiveInput {
  workspaceId?: string | null;
  agentSessionId: string;
  requestId: string;
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

export interface AgentHostAgentSessionCommandSnapshot {
  workspaceId?: string;
  agentSessionId: string;
  commands: AgentHostAgentSessionCommand[];
}

export interface AgentHostAgentSessionConfigOptionsUpdate {
  workspaceId?: string;
  agentSessionId: string;
  provider?: string;
  providerSessionId?: string;
  configOptionKey?: string;
  occurredAtUnixMs: number;
}

export interface AgentHostAgentActivityMessageUpdate {
  workspaceId?: string;
  agentSessionId: string;
  messageId: string;
  seq?: number;
  turnId?: string;
  role: string;
  kind: string;
  status?: string;
  callId?: string;
  parentCallId?: string;
  rootCallId?: string;
  title?: string;
  payload?: Record<string, unknown>;
  occurredAtUnixMs?: number;
  startedAtUnixMs?: number;
  completedAtUnixMs?: number;
}

export type AgentHostAgentActivityStreamEvent =
  | { eventType: "message_update"; data: AgentHostAgentActivityMessageUpdate }
  | { eventType: "state_patch"; data: AgentHostWorkspaceAgentStatePatch }
  | {
      eventType: "available_commands_update";
      data: AgentHostAgentSessionCommandSnapshot;
    }
  | {
      eventType: "config_options_update";
      data: AgentHostAgentSessionConfigOptionsUpdate;
    };

export interface AgentHostAgentSessionEventsSubscription {
  subscriptionId: string;
  subscribed: boolean;
}

export interface AgentHostAgentSessionEventStreamLease {
  leaseId: string;
  retained: boolean;
}
