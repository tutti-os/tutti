import type { AgentActivityUsage } from "@tutti-os/agent-activity-core";
import type {
  AgentGUINodeData,
  AgentGUIProvider,
  AgentGUIProviderRailMode,
  AgentGUIProviderReadinessGate,
  AgentGUIProviderTarget
} from "../../../types";
import type {
  AgentGUIApprovalRequest,
  AgentGUIConversationSummary,
  AgentGUIConversationUserProject,
  AgentGUIInteractivePrompt
} from "./agentGuiConversationModel";
import type { AgentGUIConversationFilter } from "./agentGuiConversationFilter";
import type {
  AgentSessionCommand,
  AgentSessionComposerSettings,
  AgentSessionPermissionConfig,
  AgentSessionReasoningEffort,
  AgentSessionSpeed,
  AgentSessionState
} from "../../../shared/agentSessionTypes";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { WorkspaceAgentSessionDetailViewModel } from "../../../shared/workspaceAgentSessionDetailViewModel";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";

export interface AgentGUISessionChrome {
  auth: {
    message: string;
  } | null;
  approval: AgentGUIApprovalRequest | null;
  recovery: {
    kind: "activating" | "failed" | "warning";
    message: string;
    canRetry?: boolean;
    followupAction?: "continue-in-new-conversation";
  } | null;
  rawState: AgentSessionState | null;
}

export interface OpenclawGatewayViewState {
  status: "starting" | "ready" | "failed";
  error: string | null;
}

export interface AgentGUIInlineNotice {
  id: string;
  message: string;
  tone: "warning" | "error";
  autoDismissMs: number | null;
}

export interface AgentGUIProjectConversationDeleteTarget {
  conversationCount: number;
  label: string;
  path: string;
}

export interface AgentGUIComposerSettingOption {
  value: string;
  label: string;
  description?: string;
  supportsImageInput?: boolean;
}

export interface AgentGUIProviderSkillOption {
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

export interface AgentComposerDraftImage {
  id: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  attachmentId?: string;
  data?: string;
  path?: string;
  previewUrl: string;
  uploading?: boolean;
  uploadError?: string;
}

export interface AgentComposerDraftFile {
  id: string;
  name: string;
  mimeType?: string;
  path?: string;
  hostPath?: string;
  assetId?: string;
  sizeBytes?: number;
  uploading?: boolean;
  uploadError?: string;
}

export interface AgentComposerDraftLargeText {
  id: string;
  name: string;
  text: string;
  sizeBytes?: number;
  path?: string;
  uploading?: boolean;
  uploadError?: string;
}

/**
 * Marks a prompt `file` content block as a pasted-text attachment (as opposed
 * to a user-attached file). Carried on the block `kind` so the round-trip
 * (submit → queue → edit-restore) can rebuild a large-text chip instead of a
 * regular file chip, and so the codex-style "read this file" instruction is
 * materialized only for these blocks at send time.
 */
export const AGENT_PASTED_TEXT_BLOCK_KIND = "pasted-text";

/**
 * Provider id of the custom mention kind used to render a pasted-text chip in
 * the conversation flow. The mention href (`mention://pasted-text/...`) carries
 * the landed archive path + size so the host can render the chip and open a
 * preview on click. Registered via registerAgentCustomMentionKind.
 */
export const AGENT_PASTED_TEXT_MENTION_KIND = "pasted-text";

export interface AgentComposerDraft {
  prompt: string;
  images: AgentComposerDraftImage[];
  files?: AgentComposerDraftFile[];
  largeTexts?: AgentComposerDraftLargeText[];
}

/**
 * Built-in glyph for a home-suggestion category chip. Keeps the localized data
 * free of any component references so it can live in the i18n label bundle.
 */
export type AgentHomeSuggestionIcon =
  | "write"
  | "code"
  | "research"
  | "handoff"
  | "breakdown"
  | "review"
  | "interaction"
  | "about"
  | "import";

/**
 * Host-level action a chip can trigger. A chip may carry an action alongside a
 * `prompt` — both fire on click (the prompt fills, then the action runs).
 * `import-session` opens the external-agent session import wizard.
 */
export type AgentHomeSuggestionAction = "import-session";

export interface AgentHomeSuggestionItem {
  id: string;
  /** Text shown in the suggestion row. */
  label: string;
  /**
   * Prompt inserted into the composer when the suggestion is chosen. Defaults
   * to `label` when omitted so short labels can double as the prompt.
   */
  prompt?: string;
}

export interface AgentHomeSuggestionCategory {
  id: string;
  /** Chip / card header label. */
  label: string;
  icon?: AgentHomeSuggestionIcon;
  /**
   * Suggestions revealed in an expandable card when the chip is chosen. Omit
   * (or leave empty) for a direct-fill chip that uses `prompt` instead.
   */
  items?: AgentHomeSuggestionItem[];
  /**
   * When set, the chip fills the composer with this prompt immediately on click
   * instead of expanding a card of `items`.
   */
  prompt?: string;
  /**
   * When set, the chip triggers a host action on click instead of filling the
   * composer or expanding `items`.
   */
  action?: AgentHomeSuggestionAction;
}

export interface AgentGUIComposerSettingsVM {
  sessionSettings: AgentSessionComposerSettings | null;
  draftSettings: {
    model: string | null;
    reasoningEffort: AgentSessionReasoningEffort | null;
    speed: AgentSessionSpeed | null;
    planMode: boolean;
    // Optional like permissionModeId: the controller always sets it, fixtures
    // and consumers default an unset value to on.
    browserUse?: boolean;
    computerUse?: boolean;
    permissionModeId?: string | null;
  };
  supportsModel: boolean;
  supportsReasoningEffort: boolean;
  supportsSpeed: boolean;
  supportsPermissionMode?: boolean;
  supportsPlanMode: boolean;
  // claude-code: plan mode overrides the permission mode in the daemon, so the
  // two are mutually exclusive and picking a permission mode clears plan. codex:
  // plan is an independent collaboration mode left untouched by permission picks.
  planExclusiveWithPermissionMode?: boolean;
  supportsBrowser?: boolean;
  supportsComputerUse?: boolean;
  isSettingsLoading: boolean;
  isModelOptionsLoading?: boolean;
  modelUnavailable: boolean;
  reasoningUnavailable: boolean;
  speedUnavailable: boolean;
  permissionModeUnavailable?: boolean;
  selectedModelValue?: string | null;
  selectedReasoningEffortValue?: AgentSessionReasoningEffort | null;
  selectedSpeedValue?: AgentSessionSpeed | null;
  selectedPermissionModeValue?: string | null;
  permissionConfig?: AgentSessionPermissionConfig | null;
  selectedProjectPath?: string | null;
  projectLocked?: boolean;
  // Mirrors the injected runtime's `projectPathIsRemote`. When true the session
  // cwd is not on the local filesystem (e.g. a shared/cloud sandbox), so the
  // local "working directory missing" existence check is skipped. Project
  // selection/listing stays available. Absent/false => local (legacy behaviour).
  projectPathIsRemote?: boolean;
  // Collapse the model list to the latest version per model family (providers
  // whose live lists span many vendors and versions, e.g. Cursor). The
  // currently selected model always stays visible even if older.
  modelListCollapsedToLatest?: boolean;
  availableModels: AgentGUIComposerSettingOption[];
  availableReasoningEfforts: AgentGUIComposerSettingOption[];
  availableSpeeds: AgentGUIComposerSettingOption[];
  availablePermissionModes?: AgentGUIComposerSettingOption[];
}

export interface AgentGUIQueuedPromptVM {
  id: string;
  content: AgentPromptContentBlock[];
  /** 仅展示用文本(bundle 折叠成一个 chip);content 仍带展开后的文件。 */
  displayPrompt?: string;
  createdAtUnixMs: number;
}

export interface AgentGUINodeViewModel {
  workspaceId: string;
  workspacePath?: string | null;
  currentUserId?: string | null;
  data: AgentGUINodeData;
  selectedProviderTarget: AgentGUIProviderTarget;
  providerTargets: readonly AgentGUIProviderTarget[];
  handoffProviderTargets: readonly AgentGUIProviderTarget[];
  providerTargetsLoading: boolean;
  /** How the rail composes its list — "exact" renders targets verbatim with no static injection. */
  providerRailMode: AgentGUIProviderRailMode;
  /** Providers gated by the host (feature-gated) — rail renders coming-soon placeholders. */
  comingSoonProviders: readonly AgentGUIProvider[];
  conversationFilter: AgentGUIConversationFilter;
  conversations: AgentGUIConversationSummary[];
  userProjects: AgentGUIConversationUserProject[];
  activeConversation: AgentGUIConversationSummary | null;
  activeConversationId: string | null;
  availableCommands: AgentSessionCommand[];
  availableSkills: AgentGUIProviderSkillOption[];
  draftPrompt: string;
  draftContent: AgentComposerDraft;
  isLoadingConversations: boolean;
  isLoadingMessages: boolean;
  isLoadingOlderMessages: boolean;
  hasOlderMessages: boolean;
  isCreatingConversation: boolean;
  isSubmitting: boolean;
  isInterrupting: boolean;
  isCancelPending: boolean;
  isRespondingApproval: boolean;
  promptImagesSupported: boolean;
  compactSupported: boolean | null;
  /**
   * Provider goal supports a real paused state (codex thread goals). Claude
   * Code's goal has none — the banner then omits pause/resume controls.
   */
  goalPauseSupported: boolean;
  usage: AgentActivityUsage | null;
  backgroundAgentCount: number;
  /** Codex plan turn finished: offer the TUI-equivalent implement prompt. */
  listError: string | null;
  isDeletingConversation: boolean;
  isDeletingProjectConversations: boolean;
  pendingDeleteConversation: AgentGUIConversationSummary | null;
  pendingDeleteProjectConversations: AgentGUIProjectConversationDeleteTarget | null;
  pendingApproval: AgentGUIApprovalRequest | null;
  pendingInteractivePrompt: AgentGUIInteractivePrompt | null;
  activeLiveState: "inactive" | "activating" | "active" | "failed";
  activationError: string | null;
  openclawGateway: OpenclawGatewayViewState | null;
  canSubmit: boolean;
  composerSettings: AgentGUIComposerSettingsVM;
  queuedPrompts: AgentGUIQueuedPromptVM[];
  drainingQueuedPromptId: string | null;
  canQueueWhileBusy: boolean;
  hasSentUserMessage: boolean;
  avoidGroupingEdits: boolean;
  conversation?: AgentConversationVM | null;
  conversationDetail: WorkspaceAgentSessionDetailViewModel | null;
  sessionChrome: AgentGUISessionChrome;
  inlineNotice: AgentGUIInlineNotice | null;
  providerReadinessGate: AgentGUIProviderReadinessGate | null;
}
