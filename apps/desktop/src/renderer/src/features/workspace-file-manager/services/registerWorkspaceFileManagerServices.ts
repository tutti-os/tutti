import { SyncDescriptor, type ServiceRegistry } from "@tutti-os/infra/di";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi, DesktopPlatformApi } from "@preload/types";
import type { IReporterService } from "../../analytics/services/reporterService.interface.ts";
import type { IDesktopPreferencesService } from "../../desktop-preferences/services/desktopPreferencesService.interface.ts";
import type { IWorkspaceUserProjectService } from "../../workspace-user-project/index.ts";
import { WorkspaceFileManagerService } from "./internal/workspaceFileManagerService";
import { IWorkspaceFileManagerService } from "./workspaceFileManagerService.interface";

export interface WorkspaceFileManagerServiceRegistrationInput {
  hostFilesApi: DesktopHostFilesApi;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedPaths"
  >;
  desktopPreferencesService?: Pick<IDesktopPreferencesService, "store">;
  reporterService?: Pick<IReporterService, "trackEvents">;
  workspaceUserProjectService?: IWorkspaceUserProjectService;
}

export function registerWorkspaceFileManagerServices(
  registry: ServiceRegistry,
  input: WorkspaceFileManagerServiceRegistrationInput
): void {
  registry.register(
    IWorkspaceFileManagerService,
    new SyncDescriptor(WorkspaceFileManagerService, [input])
  );
}
