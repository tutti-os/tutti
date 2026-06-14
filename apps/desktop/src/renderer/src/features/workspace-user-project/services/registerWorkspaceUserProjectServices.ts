import type { ServiceRegistry } from "@tutti-os/infra/di";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { NotificationService } from "@tutti-os/ui-notifications";
import type { DesktopHostFilesApi, DesktopPlatformApi } from "@preload/types";
import { DesktopWorkspaceUserProjectService } from "./internal/desktopWorkspaceUserProjectService.ts";
import {
  IWorkspaceUserProjectService,
  type IWorkspaceUserProjectService as WorkspaceUserProjectServiceInterface
} from "./workspaceUserProjectService.interface.ts";

export interface WorkspaceUserProjectServiceRegistrationInput {
  hostFilesApi: Pick<
    DesktopHostFilesApi,
    "createUserDocumentsProjectDirectory" | "selectDirectory"
  >;
  tuttidClient: TuttidClient;
  notifications?: NotificationService;
  platformApi: Pick<DesktopPlatformApi, "homeDirectory" | "os">;
  workspaceId: string;
}

export function registerWorkspaceUserProjectServices(
  registry: ServiceRegistry,
  input: WorkspaceUserProjectServiceRegistrationInput
): WorkspaceUserProjectServiceInterface {
  const service = new DesktopWorkspaceUserProjectService(input);
  registry.registerInstance(IWorkspaceUserProjectService, service);
  return service;
}
