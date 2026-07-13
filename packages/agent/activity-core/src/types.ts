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
  agentTargetId: string | null;
  provider: string;
  providerSessionId: string | null;
  userId?: string;
  model?: string | null;
  noProject?: boolean | null;
  cwd: string;
  title: string;
  activeTurnId: string | null;
  activeTurn: AgentActivityTurn | null;
  latestTurn: AgentActivityTurn | null;
  latestTurnInteractions: readonly AgentActivityInteraction[];
  pendingInteractions: readonly AgentActivityInteraction[];
  settings: AgentActivitySessionSettings;
  permissionConfig: AgentActivitySessionPermissionConfig;
  capabilities: AgentActivitySessionCapabilities | null;
  usage: AgentActivitySessionUsage | null;
  backgroundAgents: AgentActivitySessionBackgroundAgents | null;
  goal: AgentActivitySessionGoal | null;
  imported: boolean;
  visible: boolean;
  resumable: boolean;
  messageVersion: number;
  lastEventUnixMs: number;
  startedAtUnixMs: number;
  endedAtUnixMs: number | null;
  pinnedAtUnixMs: number | null;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export type AgentActivityActivationMode = "new" | "existing";
export type AgentActivityActivationStatus =
  | "attached"
  | "already_attached"
  | "failed";

export interface AgentActivityActivateSessionResult {
  session: AgentActivitySession;
  activation: {
    mode: AgentActivityActivationMode;
    status: AgentActivityActivationStatus;
  };
  error?: {
    code: string;
    message: string;
    debugMessage?: string;
  };
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

export interface AgentActivityMessage {
  workspaceId?: string;
  agentSessionId: string;
  messageId: string;
  version: number;
  turnId: string | null;
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

export interface AgentActivityRenameSessionInput {
  workspaceId: string;
  agentSessionId: string;
  title: string;
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
  supportsImageInput?: boolean;
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

export type AgentActivitySlashCommandEffect =
  | "submitImmediate"
  | "showReviewPicker"
  | "activateGoalMode"
  | "togglePlanMode"
  | "showStatus"
  | "toggleSpeed";

export interface AgentActivitySlashCommandPolicy {
  fallbackCommands: readonly string[];
  commandCatalogAuthoritative?: boolean;
  commandEffects: readonly {
    command: string;
    effect: AgentActivitySlashCommandEffect;
  }[];
}

export interface AgentActivityComposerBehavior {
  collapseModelOptionsToLatest: boolean;
  modelOptionsAuthoritative: boolean;
  refreshModelOptionsAfterSettings: boolean;
  prewarmDraftSession: boolean;
  planModeExclusiveWithPermissionMode: boolean;
}

export interface AgentActivityComposerOptions {
  provider: string;
  models: AgentActivityComposerSettingOption[];
  reasoningEfforts: AgentActivityComposerSettingOption[];
  reasoningOptionsByModel?: Record<
    string,
    {
      defaultValue?: string | null;
      options: AgentActivityComposerSettingOption[];
    }
  >;
  /** Orthogonal speed tiers (e.g. standard/fast); empty when unsupported. */
  speeds: AgentActivityComposerSettingOption[];
  /** Mirrors tuttid modelConfig.configurable; false when absent. */
  modelConfigurable?: boolean;
  /** Mirrors tuttid reasoningConfig.configurable; false when absent. */
  reasoningConfigurable?: boolean;
  /** Mirrors tuttid speedConfig.configurable; false when absent. */
  speedConfigurable?: boolean;
  /** Effective pre-session settings paired with this options snapshot. */
  effectiveSettings?: AgentActivityComposerSettings | null;
  permissionConfig?: AgentActivityComposerPermissionConfig | null;
  draftAgentSessionId?: string | null;
  modelOptionsLoading?: boolean;
  skills: AgentActivityComposerSkillOption[];
  capabilityCatalog?: AgentActivityComposerCapabilityOption[];
  behavior: AgentActivityComposerBehavior;
  slashCommandPolicy?: AgentActivitySlashCommandPolicy | null;
  loadedAtUnixMs: number;
}

export interface AgentActivityLoadComposerOptionsInput {
  /**
   * Agent target id — the daemon-facing identity of the composer target.
   * activity-core treats it as an opaque targetKey (see the controller's
   * loadComposerOptions); this field name reflects that to the daemon it is an
   * agent target id. Optional at the adapter boundary to mirror the daemon's
   * optional request field; the controller always supplies a non-empty value.
   */
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
  /**
   * Composer options cache, keyed by the opaque targetKey passed to
   * loadComposerOptions. Single key space: the key is round-tripped verbatim and
   * never parsed or rewritten.
   */
  composerOptionsByTargetKey?: Record<string, AgentActivityComposerOptions>;
}

export type AgentActivityUpdatedEvent = Extract<
  AgentActivityUpdatedPayloadV1,
  {
    eventType:
      | "interaction_update"
      | "message_update"
      | "session_deleted"
      | "session_reconcile_required"
      | "turn_update";
  }
>;

export type AgentActivitySessionEventEnvelope = Extract<
  AgentActivityUpdatedEvent,
  { eventType: "message_update" }
>;

export interface AgentActivityUpdatedApplyResult {
  applied: boolean;
  messages: AgentActivityMessage[];
  session: AgentActivitySession | null;
}

export interface AgentActivityCreateSessionInput {
  clientSubmitId: string;
  workspaceId: string;
  agentSessionId?: string | null;
  agentTargetId: string;
  cwd?: string | null;
  noProject?: boolean | null;
  initialContent?: AgentPromptContentBlock[] | null;
  /** 仅展示用的首轮文本(bundle 折叠成一个 chip);initialContent 仍带展开后的文件。 */
  initialDisplayPrompt?: string | null;
  submitDiagnostics?: AgentActivitySubmitDiagnostics;
  model?: string | null;
  planMode?: boolean | null;
  permissionModeId?: string | null;
  reasoningEffort?: string | null;
  speed?: string | null;
  title?: string | null;
  visible?: boolean | null;
  signal?: AbortSignal;
}

export interface AgentActivitySendInput {
  clientSubmitId: string;
  workspaceId: string;
  agentSessionId: string;
  content: AgentPromptContentBlock[];
  /** 仅展示用文本(bundle 折叠成一个 chip);content 仍带展开后的文件。 */
  displayPrompt?: string | null;
  guidance?: boolean;
  submitDiagnostics?: AgentActivitySubmitDiagnostics;
  signal?: AbortSignal;
}

export interface AgentActivitySubmitDiagnostics {
  submittedAtUnixMs?: number;
  blockCount?: number;
  hasImage?: boolean;
  promptLength?: number;
  queued?: boolean;
  source?: string;
}

export interface AgentActivityMessageSemantics {
  userVisibleAssistantResponse?: boolean;
  turnSettling?: boolean;
  noticeCommand?: "compact" | "review" | "undo" | "goal";
  noticeCommandStatus?: "running" | "completed" | "failed" | "canceled";
}

export interface AgentActivitySendInputResult {
  session: AgentActivitySession;
  turnId: string;
  turn: AgentActivityTurn;
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
  goal?: AgentActivitySessionGoal | null;
}

export interface AgentActivitySubmitInteractiveInput {
  workspaceId: string;
  agentSessionId: string;
  requestId: string;
  turnId: string;
  action?: string | null;
  optionId?: string | null;
  payload?: Record<string, unknown> | null;
  signal?: AbortSignal;
}

export interface AgentActivitySubmitInteractiveResult {
  session: AgentActivitySession;
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
import type {
  AgentSessionComposerSettings,
  PermissionConfig,
  WorkspaceAgentBackgroundAgents,
  WorkspaceAgentCapabilities,
  WorkspaceAgentCompletedCommand,
  WorkspaceAgentInteractionKind,
  WorkspaceAgentInteractionStatus,
  WorkspaceAgentSessionGoal,
  WorkspaceAgentUsage,
  WorkspaceAgentTurnCancelResponse,
  WorkspaceAgentTurnOutcome,
  WorkspaceAgentTurnPhase
} from "@tutti-os/client-tuttid-ts";

export interface AgentActivityTurn {
  agentSessionId: string;
  completedCommand?: WorkspaceAgentCompletedCommand | null;
  error?: { code?: string; message: string } | null;
  fileChanges?: Record<string, unknown> | null;
  outcome?: WorkspaceAgentTurnOutcome | null;
  phase: WorkspaceAgentTurnPhase;
  settledAtUnixMs?: number | null;
  startedAtUnixMs: number;
  turnId: string;
  updatedAtUnixMs: number;
}
export interface AgentActivityInteraction {
  agentSessionId: string;
  createdAtUnixMs: number;
  input?: Record<string, unknown> | null;
  kind: WorkspaceAgentInteractionKind;
  metadata?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  requestId: string;
  status: WorkspaceAgentInteractionStatus;
  toolName?: string | null;
  turnId: string;
  updatedAtUnixMs: number;
}
export type AgentActivitySessionSettings = AgentSessionComposerSettings;
export type AgentActivitySessionPermissionConfig = PermissionConfig;
export type AgentActivitySessionCapabilities = WorkspaceAgentCapabilities;
export type AgentActivitySessionBackgroundAgents =
  WorkspaceAgentBackgroundAgents;
export type AgentActivitySessionGoal = WorkspaceAgentSessionGoal;
export type AgentActivitySessionUsage = WorkspaceAgentUsage;
export type AgentActivityTurnCancelResponse = WorkspaceAgentTurnCancelResponse;

export interface AgentActivityCancelTurnInput {
  agentSessionId: string;
  turnId: string;
  workspaceId: string;
}
import type { AgentActivityUpdatedPayloadV1 } from "@tutti-os/client-tuttid-ts";
