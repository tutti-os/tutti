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
}

export interface AgentComposerDraft {
  prompt: string;
  images: AgentComposerDraftImage[];
  files?: AgentComposerDraftFile[];
  largeTexts?: AgentComposerDraftLargeText[];
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
