import type { AgentSessionCommand } from "../../../shared/agentSessionTypes";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { AgentConversationPromptVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../../shared/AgentMessageMarkdown";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto/agentSession";
import type { WorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import type { WorkspaceLinkAction } from "../../../actions/workspaceLinkActions";
import type { AgentContextMentionItem } from "../agentRichText/agentFileMentionExtension";
import type { AgentContextMentionProvider } from "../agentContextMentionProvider";
import type { AgentDroppedFileReferenceResolver } from "../model/agentDroppedFileReferences";
import type { AgentProjectPathChangeMetadata } from "../AgentComposerSettingsMenus";
import type { AgentSlashCommandCapability } from "../model/agentSlashCommandProviderPolicy";
import type {
  AgentComposerDraft,
  AgentGUIComposerSettingsVM,
  AgentGUIProviderSkillOption,
  AgentGUIQueuedPromptVM
} from "../model/agentGuiNodeTypes";
import type { AgentGUIProvider, AgentGUIAgentTarget } from "../../../types";
import type { WorkspaceReferencePickResult } from "./useComposerDraftAttachments";

export interface AgentComposerSubmitOptions {}

export interface AgentComposerProps {
  workspaceId: string;
  workspacePath?: string | null;
  currentUserId?: string | null;
  provider: string;
  slashStatus?: AgentComposerSlashStatus | null;
  usage?: AgentComposerUsage | null;
  draftContent: AgentComposerDraft;
  /** Stable project/session owner for async draft attachment work. */
  draftScopeKey?: string;
  availableCommands: readonly AgentSessionCommand[];
  hasCompactableContext?: boolean;
  compactSupported?: boolean | null;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  disabled: boolean;
  disabledReason?: string | null;
  submitDisabled: boolean;
  placeholder: string;
  composerSettings: AgentGUIComposerSettingsVM;
  queuedPrompts: readonly AgentGUIQueuedPromptVM[];
  drainingQueuedPromptId: string | null;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  selectedAgentTarget?: AgentGUIAgentTarget | null;
  agentTargets?: readonly AgentGUIAgentTarget[];
  handoffAgentTargets?: readonly AgentGUIAgentTarget[];
  providerSelectReadonly?: boolean;
  onProviderSelect?: (input: {
    provider: AgentGUIProvider;
    agentTargetId?: string | null;
  }) => void;
  onHandoffConversation?: (target: AgentGUIAgentTarget) => void;
  canQueueWhileBusy: boolean;
  showStopButton: boolean;
  activePrompt: AgentConversationPromptVM | null;
  backgroundAgentStatusText?: string | null;
  activePromptKeyboardShortcutsEnabled?: boolean;
  promptTips?: readonly AgentComposerPromptTip[];
  isInterrupting: boolean;
  isSendingTurn: boolean;
  isSubmittingPrompt: boolean;
  uiLanguage?: UiLanguage;
  isActive?: boolean;
  previewMode?: boolean;
  workspaceReferencePickerOpen?: boolean;
  promptImagesSupported?: boolean;
  canGoalControl?: boolean;
  canUploadAttachment?: boolean;
  composerFocusRequestSequence?: number | null;
  layoutMode?: "dock" | "hero";
  providerSelectLabel?: string;
  handoffLabel?: string;
  handoffMenuLabel?: string;
  labels: {
    send: string;
    modelLabel: string;
    modelSelectionLabel: string;
    modelContextWindowSuffix: string;
    modelTooltipVersionLabel: string;
    defaultModel: string;
    loadingOptions: string;
    inheritedUnavailable: string;
    loadingConversation: string;
    reasoningLabel: string;
    reasoningDegreeLabel: string;
    reasoningOptionDefault: string;
    reasoningOptionMinimal: string;
    reasoningOptionLow: string;
    reasoningOptionMedium: string;
    reasoningOptionHigh: string;
    reasoningOptionXHigh: string;
    reasoningOptionMax: string;
    reasoningOptionUltra: string;
    speedLabel: string;
    speedSelectionLabel: string;
    speedOptionStandard: string;
    speedOptionStandardDescription: string;
    speedOptionFast: string;
    speedOptionFastDescription: string;
    permissionLabel: string;
    permissionModeReadOnly: string;
    permissionModeAuto: string;
    permissionModeFullAccess: string;
    modelDescriptions: {
      frontierComplexCoding: string;
      everydayCoding: string;
      smallFastCostEfficient: string;
      codingOptimized: string;
      ultraFastCoding: string;
      professionalLongRunning: string;
    };
    planModeLabel: string;
    planModeOnLabel: string;
    planModeOffLabel: string;
    planUnavailable: string;
    goalLabel: string;
    browserUseCapabilityLabel: string;
    browserUseCapabilityDescription: string;
    browserUseCapabilityDescriptionAutoConnect: string;
    browserUseCapabilityDescriptionIsolated: string;
    browserUseCapabilitySettingsLabel: string;
    browserUseCapabilitySettingsDescription: string;
    capabilityInlineSettingsLabel: string;
    computerUseCapabilityLabel: string;
    computerUseCapabilityDescription: string;
    computerUseCapabilitySetupRequiredDescription: string;
    computerUseCapabilityAuthorizationRequiredDescription: string;
    computerUseCapabilityAuthorizationUnknownDescription: string;
    computerUseCapabilitySettingsLabel: string;
    computerUseCapabilitySettingsDescription: string;
    queuedLabel: string;
    sendQueuedPromptNext: string;
    editQueuedPrompt: string;
    deleteQueuedPrompt: string;
    queuedPromptMoreActions: string;
    stop: string;
    stopping: string;
    slashCommandPalette: string;
    skillPickerPalette: string;
    slashPaletteCommandsGroup: string;
    slashPaletteCapabilitiesGroup: string;
    slashPaletteCapabilitiesLoading: string;
    slashPaletteSkillsGroup: string;
    slashPalettePluginsGroup: string;
    slashPaletteConnectorsGroup: string;
    slashPaletteMcpGroup: string;
    slashCommandCompactLabel: string;
    slashCommandContextLabel: string;
    slashCommandFastLabel: string;
    slashCommandGoalLabel: string;
    slashCommandInitLabel: string;
    slashCommandPlanLabel: string;
    slashCommandReviewLabel: string;
    slashCommandStatusLabel: string;
    slashCommandUsageLabel: string;
    slashCommandCompactDescription: string;
    slashCommandContextDescription: string;
    slashCommandFastDescription: string;
    slashCommandGoalDescription: string;
    slashCommandInitDescription: string;
    slashCommandPlanDescription: string;
    slashCommandReviewDescription: string;
    slashCommandStatusDescription: string;
    slashCommandUsageDescription: string;
    slashStatusTitle: string;
    slashStatusSession: string;
    slashStatusBaseUrl: string;
    slashStatusContext: string;
    slashStatusLimits: string;
    slashStatusClose: string;
    slashStatusContextValue: (input: {
      percentLeft: number;
      usedTokens: string;
      totalTokens: string;
    }) => string;
    slashStatusContextUnavailable: string;
    slashStatusLimitsUnavailable: string;
    usageChipLabel: (input: { percent: number }) => string;
    usageTooltipLabel: string;
    usagePopoverTitle: string;
    usageContextWindowLabel: string;
    usageTokensLabel: string;
    usageLimitsLabel: string;
    usageCompactAction: string;
    approvalLead: string;
    planLead: string;
    planModes: Array<{ id: string; label: string; description: string }>;
    stayInPlan: string;
    sendFeedback: string;
    feedbackPlaceholder: string;
    previousQuestion: string;
    nextQuestion: string;
    submitAnswers: string;
    answerPlaceholder: string;
    waitingForAnswer: string;
    planImplementationLead: string;
    planImplementationConfirm: string;
    planImplementationFeedbackPlaceholder: string;
    planImplementationSend: string;
    planImplementationSkip: string;
    fileMentionPalette: string;
    fileMentionLoading: string;
    fileMentionEmpty: string;
    fileMentionError: string;
    fileMentionTabHint: string;
    fileDropHint: string;
    mentionPalette: string;
    removeMention: string;
    addReference: string;
    addContent: string;
    referenceWorkspaceFiles: string;
    handoffConversation: string;
    handoffConversationTooltip: string;
    handoffConversationMenu: string;
    providerSwitchLabel: string;
    projectLocked: string;
    projectMissingDescription: string;
    promptTipsPrefix: string;
    reviewPicker: {
      title: string;
      targetLabel: string;
      searchPlaceholder: string;
      noResults: string;
      uncommitted: string;
      baseBranch: string;
      commit: string;
      custom: string;
      branchLabel: string;
      branchPlaceholder: string;
      branchLoading: string;
      branchEmpty: string;
      commitPlaceholder: string;
      customPlaceholder: string;
      submit: string;
      cancel: string;
    };
  };
  workspaceUserProjectI18n: WorkspaceUserProjectI18nRuntime;
  onDraftContentChange: (
    draftContent: AgentComposerDraft,
    sourceScopeKey?: string
  ) => void;
  onProjectPathChange?: (
    path: string | null,
    metadata?: AgentProjectPathChangeMetadata
  ) => void;
  onSettingsChange: (settings: {
    model?: string | null;
    reasoningEffort?: string | null;
    speed?: string | null;
    planMode?: boolean;
    browserUse?: boolean;
    computerUse?: boolean;
    permissionModeId?: string | null;
  }) => void;
  capabilityMenuState?: AgentComposerCapabilityMenuState;
  onCapabilitySettingsRequest?: (
    capability: AgentComposerCapabilitySettingsTarget
  ) => void;
  onSlashStatusOpen?: () => void;
  onSubmit: (
    content: AgentPromptContentBlock[],
    displayPrompt?: string,
    options?: AgentComposerSubmitOptions
  ) => void;
  onSubmitGuidance?: (
    content: AgentPromptContentBlock[],
    displayPrompt?: string
  ) => void;
  onSendQueuedPromptNext: (queuedPromptId: string) => void;
  onRemoveQueuedPrompt: (queuedPromptId: string) => void;
  onEditQueuedPrompt: (queuedPromptId: string) => void;
  onInterruptCurrentTurn: () => void;
  onPromptImagesUnsupported?: () => void;
  onSubmitInteractivePrompt: (input: {
    requestId: string;
    action?: string;
    optionId?: string;
    payload?: Record<string, unknown>;
  }) => void;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onRequestWorkspaceReferences?:
    | ((
        entity?: AgentContextMentionItem | null
      ) => Promise<WorkspaceReferencePickResult>)
    | null;
  resolveDroppedFileReferences?: AgentDroppedFileReferenceResolver | null;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  onRequestGitBranches?: AgentComposerGitBranchLoader | null;
  contextMentionProviders?: readonly AgentContextMentionProvider[];
}

export type AgentComposerCapabilitySettingsTarget =
  AgentSlashCommandCapability["capability"];

export interface AgentComposerCapabilityMenuState {
  browserUse?: {
    connectionMode?: "autoConnect" | "isolated" | null;
  };
  computerUse?: {
    authorization?: AgentComposerComputerUseAuthorizationState | null;
    installed?: boolean | null;
  };
}

export type AgentComposerComputerUseAuthorizationState =
  | "authorized"
  | "needs-authorization"
  | "unknown";

export interface AgentComposerGitBranches {
  branches: readonly string[];
  currentBranch?: string | null;
}

export type AgentComposerGitBranchLoader = (input: {
  agentSessionId?: string | null;
  workingDirectory?: string | null;
}) => Promise<AgentComposerGitBranches>;

export interface AgentComposerPromptTip {
  id: string;
  label: string;
  prompt: string;
}

export interface AgentComposerSlashStatus {
  agentSessionId?: string | null;
  baseUrl?: string | null;
  contextWindow?: {
    usedTokens?: number | null;
    totalTokens?: number | null;
  } | null;
  limits?: readonly AgentComposerSlashStatusLimit[];
  limitsLoading?: boolean;
  limitsUnavailable?: boolean;
}

export interface AgentComposerSlashStatusLimit {
  id: string;
  label: string;
  percentRemaining?: number | null;
  value: string;
  reset?: string | null;
}

export interface AgentComposerUsage {
  percentUsed: number | null;
  usedTokens: number | null;
  totalTokens: number | null;
}
