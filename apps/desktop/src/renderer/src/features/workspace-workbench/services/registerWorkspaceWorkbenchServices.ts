import { SyncDescriptor, type ServiceRegistry } from "@tutti-os/infra/di";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type {
  DesktopBrowserApi,
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
import { WorkspaceWorkbenchHostService } from "./internal/workspaceWorkbenchHostService";
import { WorkspaceSettingsService } from "./internal/workspaceSettingsService";
import { IWorkspaceWorkbenchHostService } from "./workspaceWorkbenchHostService.interface";
import { IWorkspaceSettingsService } from "./workspaceSettingsService.interface";

export interface WorkspaceWorkbenchServiceRegistrationInput {
  browserApi?: DesktopBrowserApi;
  developerApi: DesktopDeveloperApi;
  dockPreviewCacheApi: DesktopDockPreviewCacheApi;
  eventStreamClient?: TuttidEventStreamClient;
  hostFilesApi: DesktopHostFilesApi;
  hostNotificationsApi: Pick<DesktopHostNotificationsApi, "onNavigate">;
  hostWindowApi: DesktopHostWindowApi;
  hostWorkspaceApi: Pick<DesktopHostWorkspaceApi, "onOpenSettingsRequest">;
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
    IWorkspaceWorkbenchHostService,
    new SyncDescriptor(WorkspaceWorkbenchHostService, [
      {
        browserApi: input.browserApi,
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
          developerApi: input.developerApi,
          runtimeApi: input.runtimeApi
        })
      }
    ])
  );
}
