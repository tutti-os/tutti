import { SyncDescriptor, type ServiceRegistry } from "@tutti-os/infra/di";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type {
  DesktopBrowserApi,
  DesktopComputerUseApi,
  DesktopDeveloperApi,
  DesktopDockPreviewCacheApi,
  DesktopHostFilesApi,
  DesktopHostNotificationsApi,
  DesktopHostWindowApi,
  DesktopHostWorkspaceApi,
  DesktopPlatformApi,
  DesktopRuntimeApi,
  DesktopWallpaperApi
} from "@preload/types";
import type { IReporterService } from "../../analytics/services/reporterService.interface.ts";
import { createDesktopWorkspaceSettingsClient } from "./internal/adapters/desktopWorkspaceSettingsClient";
import { AccountService } from "./internal/accountService";
import { WorkspaceWorkbenchHostService } from "./internal/workspaceWorkbenchHostService";
import { WorkspaceSettingsService } from "./internal/workspaceSettingsService";
import { IAccountService } from "./accountService.interface";
import { IWorkspaceWorkbenchHostService } from "./workspaceWorkbenchHostService.interface";
import { IWorkspaceSettingsService } from "./workspaceSettingsService.interface";

export interface WorkspaceWorkbenchServiceRegistrationInput {
  browserApi?: DesktopBrowserApi;
  computerUseApi: DesktopComputerUseApi;
  developerApi: DesktopDeveloperApi;
  dockPreviewCacheApi: DesktopDockPreviewCacheApi;
  eventStreamClient?: TuttidEventStreamClient;
  hostFilesApi: DesktopHostFilesApi;
  hostNotificationsApi: Pick<DesktopHostNotificationsApi, "onNavigate">;
  hostWindowApi: DesktopHostWindowApi;
  hostWorkspaceApi: Pick<
    DesktopHostWorkspaceApi,
    "broadcastAgentStatus" | "onOpenFeatureRequest" | "onOpenFileRequest"
  >;
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedPaths"
  >;
  reporterService?: Pick<IReporterService, "trackEvents">;
  runtimeApi: DesktopRuntimeApi;
  wallpaperApi: DesktopWallpaperApi;
}

export function registerWorkspaceWorkbenchServices(
  registry: ServiceRegistry,
  input: WorkspaceWorkbenchServiceRegistrationInput
): void {
  registry.register(
    IAccountService,
    new SyncDescriptor(AccountService, [
      {
        hostFilesApi: input.hostFilesApi,
        tuttidClient: input.tuttidClient
      }
    ])
  );
  registry.register(
    IWorkspaceWorkbenchHostService,
    new SyncDescriptor(WorkspaceWorkbenchHostService, [
      {
        browserApi: input.browserApi,
        computerUseApi: input.computerUseApi,
        dockPreviewCacheApi: input.dockPreviewCacheApi,
        eventStreamClient: input.eventStreamClient,
        hostFilesApi: input.hostFilesApi,
        hostNotificationsApi: input.hostNotificationsApi,
        hostWindowApi: input.hostWindowApi,
        hostWorkspaceApi: input.hostWorkspaceApi,
        tuttidClient: input.tuttidClient,
        platformApi: input.platformApi,
        reporterService: input.reporterService,
        runtimeApi: input.runtimeApi,
        wallpaperApi: input.wallpaperApi
      }
    ])
  );
  registry.register(
    IWorkspaceSettingsService,
    new SyncDescriptor(WorkspaceSettingsService, [
      {
        client: createDesktopWorkspaceSettingsClient({
          computerUseApi: input.computerUseApi,
          developerApi: input.developerApi,
          runtimeApi: input.runtimeApi
        })
      }
    ])
  );
}
