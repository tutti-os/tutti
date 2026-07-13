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
export type { AgentGUIProps } from "./AgentGUI";
export type { AgentGUIAccountMenuState } from "./agent-gui/agentGuiNode/accountMenuState";
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
  AgentGUIAgentAvailability,
  AgentGUIAgentAvailabilityAction,
  AgentGUIAgentAvailabilityStatus,
  AgentGUIAgentOwner,
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
  AgentActivityRuntimeDeleteSessionSectionResult,
  AgentActivityRuntimeSessionSectionCount,
  AgentActivityRuntimeSessionSectionScopeInput,
  AgentActivityRuntimeSetSessionPinnedInput,
  AgentActivityRuntimeUploadPromptContentInput,
  AgentActivityRuntimeUploadPromptContentResult,
  AgentActivityRuntimeUpdateSessionSettingsInput,
  AgentActivityRuntimeUpdateSessionSettingsResult
} from "./agentActivityRuntime";
export type {
  AgentHostApi,
  AgentHostApplyWorkspaceGitPatchInput,
  AgentHostInputApi,
  AgentHostSelectFilesInput,
  AgentHostRuntimeApi,
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
  AgentActivityController,
  AgentActivityMessage,
  AgentActivityNeedsAttentionItem,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
