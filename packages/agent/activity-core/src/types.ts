export type AgentActivitySessionStatus =
  | "queued"
  | "working"
  | "waiting"
  | "completed"
  | "failed"
  | "canceled"
  | "unknown";

export type AgentActivityDisplayStatus =
  | "working"
  | "waiting"
  | "idle"
  | "completed"
  | "canceled"
  | "failed";

export interface AgentActivitySession {
  workspaceId: string;
  agentSessionId: string;
  agentTargetId?: string | null;
  provider: string;
  providerSessionId?: string | null;
  userId?: string;
  model?: string | null;
  cwd: string;
  title: string;
  status: AgentActivitySessionStatus | (string & {});
  turnLifecycle?: AgentActivityTurnLifecycle | null;
  submitAvailability?: AgentActivitySubmitAvailability | null;
  pendingInteractive?: AgentActivityInteractivePrompt | null;
  visible?: boolean;
  resumable?: boolean;
  currentPhase?: string | null;
  lastError?: string | null;
  runtimeContext?: Record<string, unknown>;
  messageVersion?: number;
  lastEventUnixMs?: number;
  startedAtUnixMs?: number;
  endedAtUnixMs?: number;
  pinnedAtUnixMs?: number | null;
  createdAtUnixMs?: number;
  updatedAtUnixMs?: number;
}

export interface AgentActivityInteractivePrompt {
  kind: string;
  requestId?: string;
  toolName?: string;
  status?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type AgentActivityCancelReason =
  | "active_turn_canceled"
  | "no_active_turn"
  | "stale_turn_reconciled";

export interface AgentActivityCancelSessionResult {
  session: AgentActivitySession;
  canceled: boolean;
  reason: AgentActivityCancelReason | (string & {});
}

export interface AgentActivityMessage {
  workspaceId?: string;
  agentSessionId: string;
  messageId: string;
  id?: number;
  version: number;
  turnId: string;
  role: string;
  kind: string;
  status?: string | null;
  semantics?: AgentActivityMessageSemantics;
  payload: Record<string, unknown>;
  occurredAtUnixMs: number;
  startedAtUnixMs?: number;
  completedAtUnixMs?: number;
}

export interface AgentActivitySessionList {
  sessions: AgentActivitySession[];
  presences?: AgentActivityPresence[];
}

export interface AgentActivityPresence {
  id: string | number;
  workspaceId: string;
  provider: string;
  status: string;
  userId?: string | null;
}

export interface AgentActivityMessagePage {
  messages: AgentActivityMessage[];
  hasMore: boolean;
  latestVersion: number;
}

export type AgentActivityMessageOrder = "asc" | "desc";

export interface AgentActivityComposerSettingOption {
  value: string;
  label: string;
  description?: string;
}

export interface AgentActivityComposerSkillOption {
  name: string;
  trigger: string;
  sourceKind:
    | "project"
    | "personal"
    | "bundled"
    | "plugin"
    | "system"
    | "tutti-injected"
    | "connector";
  description?: string;
  pluginName?: string;
  path?: string;
  kind?: "skill" | "connector";
}

export interface AgentActivityComposerCapabilityOption {
  id: string;
  kind: "skill" | "plugin" | "connector" | "mcpServer" | "mcpTool";
  name: string;
  label: string;
  status:
    | "available"
    | "disabled"
    | "authRequired"
    | "setupRequired"
    | "unsupported";
  invocation: "promptItem" | "textTrigger" | "none";
  description?: string;
  source?: string;
  pluginName?: string;
  serverName?: string;
  toolName?: string;
  trigger?: string;
  path?: string;
}

export interface AgentActivityComposerPermissionModeOption {
  id: string;
  label?: string;
  description?: string;
  semantic?: string;
}

export interface AgentActivityComposerPermissionConfig {
  configurable: boolean;
  defaultValue?: string | null;
  modes: AgentActivityComposerPermissionModeOption[];
}

export interface AgentActivityComposerSettings {
  model?: string | null;
  reasoningEffort?: string | null;
  speed?: string | null;
  planMode?: boolean | null;
  permissionModeId?: string | null;
}

export interface AgentActivityComposerOptions {
  provider: string;
  models: AgentActivityComposerSettingOption[];
  reasoningEfforts: AgentActivityComposerSettingOption[];
  /** Orthogonal speed tiers (e.g. standard/fast); empty when unsupported. */
  speeds: AgentActivityComposerSettingOption[];
  /** Mirrors tuttid modelConfig.configurable; false when absent. */
  modelConfigurable?: boolean;
  /** Mirrors tuttid reasoningConfig.configurable; false when absent. */
  reasoningConfigurable?: boolean;
  /** Mirrors tuttid speedConfig.configurable; false when absent. */
  speedConfigurable?: boolean;
  permissionConfig?: AgentActivityComposerPermissionConfig | null;
  runtimeContext?: Record<string, unknown>;
  skills: AgentActivityComposerSkillOption[];
  capabilityCatalog?: AgentActivityComposerCapabilityOption[];
  loadedAtUnixMs: number;
}

export interface AgentActivityLoadComposerOptionsInput {
  agentTargetId?: string | null;
  workspaceId: string;
  provider: string;
  cwd?: string | null;
  settings?: AgentActivityComposerSettings | null;
  signal?: AbortSignal;
}

export interface AgentActivitySnapshot {
  workspaceId: string;
  sessions: AgentActivitySession[];
  presences: AgentActivityPresence[];
  sessionMessagesById: Record<string, AgentActivityMessage[]>;
  composerOptionsByAgentTargetId?: Record<string, AgentActivityComposerOptions>;
  composerOptionsByProvider?: Record<string, AgentActivityComposerOptions>;
}

export interface AgentActivitySessionEventEnvelope {
  workspaceId: string;
  agentSessionId: string;
  eventType: string;
  data?: unknown;
}

export interface AgentActivityUpdatedEvent {
  workspaceId: string;
  agentSessionId: string;
  eventType: string;
  data?: unknown;
}

export interface AgentActivityStatePatch {
  agentSessionId: string;
  agentTargetId?: string;
  currentPhase?: string;
  cwd?: string;
  lastError?: string;
  lastEventUnixMs?: number;
  lifecycleStatus?: string;
  model?: string;
  occurredAtUnixMs?: number;
  provider?: string;
  providerSessionId?: string;
  runtimeContext?: Record<string, unknown>;
  startedAtUnixMs?: number;
  submitAvailability?: AgentActivitySubmitAvailability;
  pendingInteractive?: AgentActivityInteractivePrompt | null;
  endedAtUnixMs?: number;
  title?: string;
  turn?: {
    activeTurnId?: string | null;
    completedCommand?: AgentActivityCompletedCommand | null;
    completedAtUnixMs?: number;
    fileChanges?: unknown;
    outcome?: string;
    phase?: string;
    settling?: boolean;
    submitAvailability?: AgentActivitySubmitAvailability;
    startedAtUnixMs?: number;
    turnId: string;
  };
  workspaceId?: string;
}

export interface AgentActivityUpdatedApplyResult {
  applied: boolean;
  messages: AgentActivityMessage[];
  session: AgentActivitySession | null;
  statePatch: AgentActivityStatePatch | null;
}

export interface AgentActivityCreateSessionInput {
  workspaceId: string;
  agentSessionId?: string | null;
  agentTargetId: string;
  cwd?: string | null;
  initialContent?: AgentPromptContentBlock[] | null;
  /** 仅展示用的首轮文本(bundle 折叠成一个 chip);initialContent 仍带展开后的文件。 */
  initialDisplayPrompt?: string | null;
  metadata?: Record<string, unknown>;
  model?: string | null;
  planMode?: boolean | null;
  permissionModeId?: string | null;
  reasoningEffort?: string | null;
  runtimeContext?: Record<string, unknown> | null;
  speed?: string | null;
  title?: string | null;
  visible?: boolean | null;
  signal?: AbortSignal;
}

export interface AgentActivitySendInput {
  workspaceId: string;
  agentSessionId: string;
  content: AgentPromptContentBlock[];
  /** 仅展示用文本(bundle 折叠成一个 chip);content 仍带展开后的文件。 */
  displayPrompt?: string | null;
  guidance?: boolean;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export type AgentActivityTurnPhase =
  | "submitted"
  | "running"
  | "waiting"
  | "settled";

export type AgentActivityTurnOutcome =
  | "completed"
  | "failed"
  | "canceled"
  | (string & {});

export interface AgentActivityCompletedCommand {
  kind: "compact" | "review" | "undo" | "goal" | (string & {});
  status: "completed" | "failed" | "canceled" | (string & {});
}

export interface AgentActivityTurnLifecycle {
  activeTurnId: string | null;
  phase: AgentActivityTurnPhase | (string & {});
  settling?: boolean;
  outcome?: AgentActivityTurnOutcome | null;
  completedCommand?: AgentActivityCompletedCommand | null;
}

export interface AgentActivitySubmitAvailability {
  state: "available" | "blocked" | "queueable" | (string & {});
  reason?: string;
}

export interface AgentActivityMessageSemantics {
  userVisibleAssistantResponse?: boolean;
  turnSettling?: boolean;
  noticeCommand?: "compact" | "review" | "undo" | "goal" | (string & {});
  noticeCommandStatus?:
    | "running"
    | "completed"
    | "failed"
    | "canceled"
    | (string & {});
}

export interface AgentActivitySendInputResult {
  session: AgentActivitySession;
  turnId: string;
  turnLifecycle: AgentActivityTurnLifecycle;
  submitAvailability: AgentActivitySubmitAvailability;
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

export interface AgentActivityCancelSessionInput {
  workspaceId: string;
  agentSessionId: string;
  signal?: AbortSignal;
}

export type AgentActivityGoalControlAction =
  | "pause"
  | "resume"
  | "clear"
  | "set";

export interface AgentActivityGoalControlInput {
  workspaceId: string;
  agentSessionId: string;
  action: AgentActivityGoalControlAction;
  objective?: string;
  signal?: AbortSignal;
}

export interface AgentActivityGoalControlResult {
  session: AgentActivitySession;
  goal?: Record<string, unknown> | null;
}

export interface AgentActivitySubmitInteractiveInput {
  workspaceId: string;
  agentSessionId: string;
  requestId: string;
  action?: string | null;
  optionId?: string | null;
  payload?: Record<string, unknown> | null;
  signal?: AbortSignal;
}

export interface AgentActivityDeleteSessionInput {
  workspaceId: string;
  agentSessionId: string;
  signal?: AbortSignal;
}

export interface AgentActivityDeleteSessionResult {
  removed: boolean;
}

export type AgentActivityNeedsAttentionKind =
  | "permission"
  | "question"
  | "constraint"
  | "other";

export interface AgentActivityNeedsAttentionItem {
  id: string;
  workspaceId: string;
  agentSessionId: string;
  provider: string;
  title: string;
  cwd: string;
  kind: AgentActivityNeedsAttentionKind;
  summary: string;
  occurredAtUnixMs: number;
}
