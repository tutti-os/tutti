import { createDecorator } from "@tutti-os/infra/di";
import type { AgentDirectoryService } from "./agentDirectoryService";
import type { ComposerDraftService } from "./composerDraftService";
import type { DeviceService } from "./deviceService";
import type { LoginService } from "./loginService";
import type { MobileApplicationService } from "./mobileApplicationService";
import type { WorkspaceActivityService } from "./workspaceActivityService";
import type { WorkspaceCatalogService } from "./workspaceCatalogService";
import type { WorkspaceNavigationService } from "./workspaceNavigationService";

export const IMobileApplicationService =
  createDecorator<MobileApplicationService>("mobile-application-service");
export const ILoginService = createDecorator<LoginService>(
  "mobile-login-service"
);
export const IDeviceService = createDecorator<DeviceService>(
  "mobile-device-service"
);
export const IAgentDirectoryService = createDecorator<AgentDirectoryService>(
  "mobile-agent-directory-service"
);
export const IWorkspaceCatalogService =
  createDecorator<WorkspaceCatalogService>("mobile-workspace-catalog-service");
export const IWorkspaceActivityService =
  createDecorator<WorkspaceActivityService>(
    "mobile-workspace-activity-service"
  );
export const IWorkspaceNavigationService =
  createDecorator<WorkspaceNavigationService>(
    "mobile-workspace-navigation-service"
  );
export const IComposerDraftService = createDecorator<ComposerDraftService>(
  "mobile-composer-draft-service"
);
