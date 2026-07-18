export {
  getAgentCustomMentionKind,
  registerAgentCustomMentionKind,
  resetAgentCustomMentionKindsForTests,
  type AgentCustomMentionChipContext,
  type AgentCustomMentionIdentity,
  type AgentCustomMentionKindDefinition,
  type AgentCustomMentionPresentation
} from "./shared/agentCustomMentionKinds";
export {
  AGENT_PASTED_TEXT_BLOCK_KIND,
  AGENT_PASTED_TEXT_MENTION_KIND
} from "./shared/pastedTextKinds";
export { AgentGUI } from "./AgentGUI";
export type {
  AgentGUIProps,
  AgentGUIReferenceProvenanceFilterCatalog
} from "./AgentGUI";
export type { AgentGUIComposerAppendRequest } from "./agent-gui/agentGuiNode/controller/useAgentGUIComposerAppendRequest";
export type { AgentComposerDraftFile } from "./agent-gui/agentGuiNode/model/agentGuiNodeTypes";
export type { AgentGUIAccountMenuState } from "./agent-gui/agentGuiNode/accountMenuState";
export type {
  AgentGUIComposerContentType,
  AgentGUIComposerFocusMethod,
  AgentGUIEngagementContext,
  AgentGUIEngagementEvent,
  AgentGUIEngagementEventSink
} from "./agent-gui/agentGuiNode/engagement/agentGUIEngagement.types";
export {
  agentGUIAgentIsReady,
  normalizeAgentGUIAgents,
  resolveAgentGUISelectedDirectoryAgent
} from "./agents";
export {
  agentGUIDefaultTargetProviders,
  createLocalAgentGUIAgentTarget,
  createLocalAgentGUIAgentTargets,
  createSharedAgentGUIAgentTarget,
  localAgentGUIAgentTargetId,
  normalizeAgentGUIAgentTargets,
  resolveAgentGUIAgentTarget
} from "./agentTargets";
export type {
  AgentGUIAgent,
  AgentGUIAgentDirectoryPort,
  AgentGUIAgentDirectorySnapshot,
  AgentGUIAgentDirectoryStatus,
  AgentGUIAgentAvailability,
  AgentGUIAgentAvailabilityAction,
  AgentGUIAgentAvailabilityStatus,
  AgentGUIAgentOwner,
  AgentGUIAgentOwnership,
  AgentGUIHomeSuggestionId,
  AgentGUIAllAgentsPresentation,
  AgentGUIProvider,
  AgentGUIProviderRailAllPresentation,
  AgentGUIProviderRailMode,
  AgentGUIProviderReadinessGate,
  AgentGUIProviderReadinessGateAction,
  AgentGUIProviderReadinessGateStatus,
  AgentGUIAgentTarget,
  AgentGUIAgentTargetBadge,
  AgentGUIAgentTargetRef
} from "./types";
export {
  AgentGuiI18nProvider,
  agentGuiI18nModule,
  agentGuiI18nResources
} from "./i18n/index";
export type { AgentGuiI18nLocale } from "./i18n/index";
export { agentGuiDockIconUrl, agentGuiDockIconUrls } from "./dockIcons";
export {
  AGENT_GUI_DETAIL_MIN_WIDTH_PX,
  AGENT_GUI_EXPANDED_TARGET_WIDTH_PX,
  AGENT_GUI_STANDALONE_AUTO_COLLAPSE_WIDTH_PX,
  resolveAgentGUIExpandedWindowFrame,
  shouldAutoCollapseAgentGUIConversationRail
} from "./agent-gui/agentGuiNode/model/agentGuiRailLayout";
export type {
  AgentGUIAgentsEmptyRenderer,
  AgentGUIProviderUnavailableStateContext,
  AgentGUIProviderUnavailableStateRenderer,
  AgentGUISidebarFooterContext,
  AgentGUISidebarFooterRenderer
} from "./agent-gui/agentGuiNode/AgentGUINodeView";
export {
  AGENT_CONTEXT_MENTION_PROVIDER_IDS,
  type AgentContextMentionProviderId,
  type AgentContextMentionProvider
} from "./agent-gui/agentGuiNode/agentContextMentionProvider";
export { preloadAgentMentionBrowse } from "./agent-gui/agentGuiNode/AgentMentionSearchController";
export { AgentActivityHostProvider } from "./agentActivityHost";
export type { AgentActivityHostProviderProps } from "./agentActivityHost";
export { useEngineSelector } from "./shared/engine/useEngineSelector";
export type { EngineStateStore } from "./shared/engine/useEngineSelector";
export {
  dispatchAgentPlanPromptAction,
  selectAgentPlanPromptTurn
} from "./shared/agentConversation/agentPlanPromptDispatch";
export type { AgentPlanPromptAction } from "./shared/agentConversation/agentPlanPromptDispatch";
export {
  AgentActivityRuntimeProvider,
  resetAgentActivityRuntimeForTests,
  setAgentActivityRuntimeForTests,
  useAgentActivitySnapshot,
  useAgentActivityRuntime,
  useOptionalAgentActivityRuntime
} from "./agentActivityRuntime";
export type {
  AgentActivityRuntime,
  AgentActivityRuntimeListSessionMessagesInput,
  AgentActivityRuntimeProviderProps,
  AgentActivityRuntimePromptContentBlock,
  AgentActivityRuntimeDeleteSessionsBatchInput,
  AgentActivityRuntimeDeleteSessionsBatchResult,
  AgentActivityRuntimeSessionSectionDeletionCandidates,
  AgentActivityRuntimeSessionSectionScopeInput,
  AgentActivityRuntimeSetSessionPinnedInput,
  AgentActivityRuntimeUploadPromptContentInput,
  AgentActivityRuntimeUploadPromptContentResult,
  AgentActivityRuntimeUpdateSessionSettingsInput,
  AgentActivityRuntimeUpdateSessionSettingsResult
} from "./agentActivityRuntime";
export type {
  AgentHostApi,
  AgentHostAgentTargetAuthenticatedAccount,
  AgentHostAgentTargetSetupSnapshot,
  AgentHostAgentTargetSetupState,
  AgentHostAgentTargetSetupWatch,
  AgentHostApplyWorkspaceGitPatchInput,
  AgentHostInputApi,
  AgentHostSelectFilesInput,
  AgentHostRuntimeApi,
  AgentHostUserProject,
  AgentProviderProbeListInput,
  AgentProviderProbeListResult
} from "./host/agentHostApi";
export type {
  AgentProbeProvider,
  AgentProbeSnapshot,
  PersistWriteResult,
  ReadWorkspaceAgentReadStateInput,
  AgentUsageQuota,
  AgentUsageSnapshot,
  WorkspaceAgentReadStateSnapshot,
  WriteWorkspaceAgentReadStateInput
} from "./shared/contracts/dto";
export {
  selectNeedsAttentionCount,
  selectNeedsAttentionItems
} from "@tutti-os/agent-activity-core";
export type {
  AgentActivityAdapter,
  AgentActivityMessage,
  AgentActivityNeedsAttentionItem,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
