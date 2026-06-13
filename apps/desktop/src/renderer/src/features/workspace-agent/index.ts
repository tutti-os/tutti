export { registerWorkspaceAgentServices } from "./services/registerWorkspaceAgentServices";
export { IAgentProviderStatusService } from "./services/agentProviderStatusService.interface";
export { createDesktopAgentGUIWorkbenchHostInput } from "./services/createDesktopAgentGUIWorkbenchHostInput";
export { createDesktopAgentActivityRuntime } from "./services/createDesktopAgentActivityRuntime";
export { createDesktopAgentHostApi } from "./services/createDesktopAgentHostApi";
export { IWorkspaceAgentActivityService } from "./services/workspaceAgentActivityService.interface";
export { IWorkspaceAgentPromptSessionService } from "./services/workspaceAgentPromptSessionService.interface";
export {
  registerWorkspaceAgentGuiLaunchHandler,
  requestWorkspaceAgentGuiLaunch
} from "./services/workspaceAgentGuiLaunchCoordinator";
export { DesktopAgentGUIWorkbenchBody } from "./ui/DesktopAgentGUIWorkbenchBody";
export { DesktopAgentGUIWorkbenchHeader } from "./ui/DesktopAgentGUIWorkbenchHeader";
export {
  createDesktopAgentGUINodeStateSource,
  desktopAgentGUIOpenSessionActivationType,
  desktopAgentGUIProviderFromInstanceId,
  normalizeDesktopAgentGUINodeState,
  normalizeDesktopAgentGUIWorkbenchState
} from "./desktopAgentGUINodeState";
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
