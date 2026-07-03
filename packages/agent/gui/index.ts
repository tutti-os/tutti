export {
  buildAgentActivitySnapshotProjection,
  agentHostSnapshotFromAgentActivitySnapshot,
  projectCoreSessionStatus,
  type AgentActivitySnapshotProjection
} from "./shared/agentActivitySnapshotProjection";
export {
  getAgentCustomMentionKind,
  registerAgentCustomMentionKind,
  resetAgentCustomMentionKindsForTests,
  type AgentCustomMentionChipContext,
  type AgentCustomMentionIdentity,
  type AgentCustomMentionKindDefinition,
  type AgentCustomMentionPresentation
} from "./shared/agentCustomMentionKinds";
export { AgentGUI } from "./AgentGUI";
export type { AgentGUIProps } from "./AgentGUI";
export {
  agentGUIDefaultTargetProviders,
  createLocalAgentGUIProviderTarget,
  createLocalAgentGUIProviderTargets,
  localAgentGUIProviderTargetId,
  normalizeAgentGUIProviderTargets,
  resolveAgentGUIProviderTarget
} from "./providerTargets";
export type {
  AgentGUIProvider,
  AgentGUIProviderReadinessGate,
  AgentGUIProviderReadinessGateAction,
  AgentGUIProviderReadinessGateStatus,
  AgentGUIProviderTarget,
  AgentGUIProviderTargetRef
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
export {
  AGENT_CONTEXT_MENTION_PROVIDER_IDS,
  type AgentContextMentionProviderId,
  type AgentContextMentionProvider
} from "./agent-gui/agentGuiNode/agentContextMentionProvider";
export { preloadAgentMentionBrowse } from "./agent-gui/agentGuiNode/AgentMentionSearchController";
export { AgentActivityHostProvider } from "./agentActivityHost";
export type { AgentActivityHostProviderProps } from "./agentActivityHost";
export {
  AgentActivityRuntimeProvider,
  getAgentActivityRuntime,
  getOptionalAgentActivityRuntime,
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
  AgentActivityRuntimeRetainSessionEventsInput,
  AgentActivityRuntimeSetSessionPinnedInput,
  AgentActivityRuntimeUploadPromptContentInput,
  AgentActivityRuntimeUploadPromptContentResult,
  AgentActivityRuntimeUpdateSessionSettingsInput,
  AgentActivityRuntimeWarmupOpenclawGatewayInput
} from "./agentActivityRuntime";
export {
  AgentQueuedPromptRuntimeProvider,
  createAgentQueuedPromptRuntime,
  resetAgentQueuedPromptRuntimeForTests,
  setAgentQueuedPromptRuntimeForTests,
  useAgentQueuedPromptRuntime,
  useAgentQueuedPromptSessionSnapshot
} from "./agentQueuedPromptRuntime";
export type {
  AgentQueuedPromptClaim,
  AgentQueuedPromptClaimResult,
  AgentQueuedPromptQueueSnapshot,
  AgentQueuedPromptRetryBlock,
  AgentQueuedPromptRuntime,
  AgentQueuedPromptRuntimeProviderProps,
  AgentQueuedPromptSnapshot
} from "./agentQueuedPromptRuntime";
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
