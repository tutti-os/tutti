export { WorkspaceWorkbench } from "./ui/WorkspaceWorkbench";
export { FusionDockWindow } from "./ui/FusionDockWindow";
export { FusionToolWindow } from "./ui/FusionToolWindow";
export { registerFusionDockService } from "./services/registerFusionDockService.ts";
export { registerWorkspaceWorkbenchServices } from "./services/registerWorkspaceWorkbenchServices";
export { createAgentProviderTerminalCommandRunner } from "./services/createAgentProviderTerminalCommandRunner";
export { createWorkspaceAgentOutcomeNotificationController } from "./services/workspaceAgentOutcomeNotification";
export { createWorkspaceAgentOutcomeForegroundNotificationPresenter } from "./ui/WorkspaceAgentOutcomeNotificationToast";
export { IWorkspaceSettingsService } from "./services/workspaceSettingsService.interface";
export { IFusionDockService } from "./services/fusionDockService.interface.ts";
export {
  createWorkspaceDockRetentionActionId,
  findWorkspaceDockLauncherCatalogEntry,
  readWorkspaceAppIdFromDockEntryId,
  readWorkspaceDockRetentionActionEntryId,
  resolveWorkspaceDockLauncherCatalog,
  type WorkspaceDockLauncherCatalogInput
} from "./services/workspaceDockLauncherCatalog.ts";
