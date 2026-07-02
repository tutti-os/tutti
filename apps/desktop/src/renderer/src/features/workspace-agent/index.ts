export { registerWorkspaceAgentServices } from "./services/registerWorkspaceAgentServices";
export { IAgentsService } from "./services/agentsService.interface";
export { IAgentProviderStatusService } from "./services/agentProviderStatusService.interface";
export { createDesktopAgentGUIWorkbenchHostInput } from "./services/createDesktopAgentGUIWorkbenchHostInput";
export { preloadDesktopAgentGuiMentionBrowse } from "./services/preloadDesktopAgentGuiMentionBrowse";
export { createDesktopAgentActivityRuntime } from "./services/createDesktopAgentActivityRuntime";
export { createDesktopAgentHostApi } from "./services/createDesktopAgentHostApi";
export { createDesktopAgentGeneratedFileMentionProvider } from "./services/internal/createDesktopAgentGeneratedFileMentionProvider";
export { IWorkspaceAgentActivityService } from "./services/workspaceAgentActivityService.interface";
export { IWorkspaceAgentPromptSessionService } from "./services/workspaceAgentPromptSessionService.interface";
export {
  registerWorkspaceAgentGuiLaunchHandler,
  requestWorkspaceAgentGuiLaunch
} from "./services/workspaceAgentGuiLaunchCoordinator";
export { AgentEnvPanel } from "./ui/AgentEnvPanel";
export { DesktopAgentGUIWorkbenchBody } from "./ui/DesktopAgentGUIWorkbenchBody";
export { DesktopAgentGUIWorkbenchHeader } from "./ui/DesktopAgentGUIWorkbenchHeader";
export { DesktopAgentProviderManageDialog } from "./ui/DesktopAgentProviderManageDialog";
export {
  createDesktopAgentGUINodeStateSource,
  desktopAgentGUIOpenSessionActivationType,
  desktopAgentGUIProviderFromInstanceId,
  normalizeDesktopAgentGUINodeState,
  normalizeDesktopAgentGUIProvider,
  normalizeDesktopAgentGUIWorkbenchState
} from "./desktopAgentGUINodeState";
export type {
  AgentTargetPresentation,
  AgentsSnapshot,
  IAgentsService as AgentsService
} from "./services/agentsService.interface";
export type {
  AgentProviderStatusActionContext,
  AgentProviderStatusSnapshot,
  AgentProviderTerminalCommandRunner,
  IAgentProviderStatusService as AgentProviderStatusService
} from "./services/agentProviderStatusService.interface";
export type { IWorkspaceAgentActivityService as WorkspaceAgentActivityService } from "./services/workspaceAgentActivityService.interface";
export type {
  IWorkspaceAgentPromptSessionService as WorkspaceAgentPromptSessionService,
  WorkspaceAgentPromptSessionCreateInput,
  WorkspaceAgentPromptSessionCreateResult
} from "./services/workspaceAgentPromptSessionService.interface";
export type { DesktopAgentGUIWorkbenchHostInput } from "./services/createDesktopAgentGUIWorkbenchHostInput";
export type { DesktopAgentGUIProvider } from "./desktopAgentGUINodeState";
