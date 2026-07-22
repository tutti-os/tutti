import { SyncDescriptor, type ServiceRegistry } from "@tutti-os/infra/di";
import { WorkbenchHostCoordinator } from "@tutti-os/workbench-host";
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
import {
  WorkspaceSettingsService,
  type WorkspaceSettingsServiceDependencies
} from "./internal/workspaceSettingsService";
import { IAccountService } from "./accountService.interface";
import { IWorkbenchHostCoordinator } from "./workbenchHostCoordinator.interface.ts";
import { IWorkspaceWorkbenchHostService } from "./workspaceWorkbenchHostService.interface";
import type { DesktopWorkspaceWorkbenchRepository } from "./internal/adapters/desktopWorkspaceWorkbenchRepository.ts";
import { IWorkspaceSettingsService } from "./workspaceSettingsService.interface";
import type { IAgentQuickPromptService } from "../../workspace-agent/services/agentQuickPromptService.interface.ts";

export interface WorkspaceWorkbenchServiceRegistrationInput {
  agentQuickPromptService?: IAgentQuickPromptService;
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
    | "broadcastAgentStatus"
    | "onOpenFeatureRequest"
    | "onOpenFileRequest"
    | "replaceWorkspaceWindow"
  >;
  launchAgentGui?: WorkspaceSettingsServiceDependencies["launchAgentGui"];
  tuttidClient: TuttidClient;
  platformApi: Pick<
    DesktopPlatformApi,
    "homeDirectory" | "os" | "resolveDroppedPaths"
  >;
  reporterService?: Pick<IReporterService, "trackEvents">;
  runtimeApi: DesktopRuntimeApi;
  snapshotRepository: DesktopWorkspaceWorkbenchRepository;
  wallpaperApi: DesktopWallpaperApi;
  onAgentTargetsChanged?: () => void | Promise<void>;
}

export interface WorkspaceAccountServiceRegistrationInput {
  hostFilesApi: DesktopHostFilesApi;
  tuttidClient: TuttidClient;
}

export function registerWorkspaceAccountService(
  registry: ServiceRegistry,
  input: WorkspaceAccountServiceRegistrationInput
): IAccountService {
  const accountService = new AccountService({
    hostFilesApi: input.hostFilesApi,
    tuttidClient: input.tuttidClient
  });
  registry.registerInstance(IAccountService, accountService);
  return accountService;
}

export function registerWorkspaceWorkbenchServices(
  registry: ServiceRegistry,
  input: WorkspaceWorkbenchServiceRegistrationInput
): void {
  registry.register(
    IWorkbenchHostCoordinator,
    new SyncDescriptor(WorkbenchHostCoordinator)
  );
  registry.register(
    IWorkspaceWorkbenchHostService,
    new SyncDescriptor(WorkspaceWorkbenchHostService, [
      {
        agentQuickPromptService: input.agentQuickPromptService,
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
        snapshotRepository: input.snapshotRepository,
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
          runtimeApi: input.runtimeApi,
          tuttidClient: input.tuttidClient
        }),
        launchAgentGui: input.launchAgentGui,
        onAgentTargetsChanged: input.onAgentTargetsChanged,
        replaceWorkspaceWindow: input.hostWorkspaceApi.replaceWorkspaceWindow
      }
    ])
  );
}
