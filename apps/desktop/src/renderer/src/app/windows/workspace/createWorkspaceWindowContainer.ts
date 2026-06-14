import { InstantiationService, ServiceRegistry } from "@tutti-os/infra/di";
import {
  isAnalyticsDebugAvailable,
  registerAnalyticsDebugServices
} from "@renderer/features/analytics-debug";
import {
  registerReporterServices,
  startPredefinePageviewAnalytics
} from "@renderer/features/analytics";
import { registerAppUpdateServices } from "@renderer/features/app-update";
import { registerDesktopPreferencesServices } from "@renderer/features/desktop-preferences";
import { registerRichTextAtServices } from "@renderer/features/rich-text-at";
import { registerWorkspaceAgentServices } from "@renderer/features/workspace-agent";
import { registerWorkspaceAppCenterServices } from "@renderer/features/workspace-app-center";
import { registerWorkspaceCatalogServices } from "@renderer/features/workspace-catalog";
import { registerWorkspaceFileManagerServices } from "@renderer/features/workspace-file-manager";
import { registerWorkspaceUserProjectServices } from "@renderer/features/workspace-user-project";
import {
  createAgentProviderTerminalCommandRunner,
  registerWorkspaceWorkbenchServices
} from "@renderer/features/workspace-workbench";
import { INotificationService } from "@tutti-os/ui-notifications";
import { createToastNotificationService } from "@renderer/lib/notificationService";
import {
  createCompositeNotificationService,
  createDefaultBackgroundNotificationPolicy,
  createDocumentNotificationVisibilityState,
  createHostBackgroundNotificationPresenter
} from "@renderer/lib/compositeNotificationService";
import { installRendererDiagnostics } from "@renderer/lib/rendererDiagnostics";
import { resolveDesktopEnvironment } from "@renderer/platform/desktop/resolveDesktopEnvironment";
import { createDesktopTuttidEventStreamClient } from "@renderer/platform/tuttid/createDesktopTuttidEventStreamClient";
import { createDesktopTuttidClient } from "@renderer/platform/tuttid/createDesktopTuttidClient";
import { startDesktopDaemonConnectionAnalytics } from "@renderer/platform/tuttid/desktopDaemonConnectionAnalytics";

export interface WorkspaceWindowContainerResult {
  container: InstantiationService;
  environmentMode: "desktop" | "web";
  startupWorkspaceID: string | null;
}

export function createWorkspaceWindowContainer(): WorkspaceWindowContainerResult {
  const environment = resolveDesktopEnvironment(window.tutti);
  const desktopApi = environment.desktopApi;
  const tuttidClient = createDesktopTuttidClient(desktopApi.runtime);
  const tuttidEventStreamClient = createDesktopTuttidEventStreamClient(
    desktopApi.runtime
  );
  const registry = new ServiceRegistry();
  const foregroundNotificationService = createToastNotificationService();
  const notificationService = createCompositeNotificationService({
    background: createHostBackgroundNotificationPresenter(
      desktopApi.host.notifications
    ),
    foreground: {
      show(message) {
        foregroundNotificationService.notify(message);
      }
    },
    policy: createDefaultBackgroundNotificationPolicy(),
    visibility: createDocumentNotificationVisibilityState({
      hasFocus: () => document.hasFocus(),
      visibilityState: () => document.visibilityState
    })
  });
  registry.registerInstance(INotificationService, notificationService);
  const analyticsDebugAvailable = isAnalyticsDebugAvailable({
    isDev: import.meta.env.DEV
  });
  registerAnalyticsDebugServices(registry, {
    available: analyticsDebugAvailable,
    eventStreamClient: tuttidEventStreamClient
  });
  const reporterService = registerReporterServices(registry, {
    tuttidClient
  });
  const predefinePageviewAnalytics = startPredefinePageviewAnalytics({
    reporterService
  });
  installRendererDiagnostics(
    desktopApi.runtime,
    "workspace-renderer",
    reporterService
  );
  registerDesktopPreferencesServices(
    registry,
    tuttidClient,
    tuttidEventStreamClient
  );
  const daemonConnectionAnalytics = startDesktopDaemonConnectionAnalytics({
    eventStreamClient: tuttidEventStreamClient,
    reporterService
  });
  let releasedWindowAnalytics = false;
  const releaseWindowAnalytics = () => {
    if (releasedWindowAnalytics) {
      return;
    }
    releasedWindowAnalytics = true;
    window.removeEventListener("beforeunload", releaseWindowAnalytics);
    predefinePageviewAnalytics.dispose();
    daemonConnectionAnalytics.release();
  };
  window.addEventListener("beforeunload", releaseWindowAnalytics);
  registerAppUpdateServices(registry, desktopApi, {
    reporterService
  });
  registerWorkspaceCatalogServices(registry, {
    hostApi: {
      platform: desktopApi.platform.os,
      workspace: desktopApi.host.workspace
    },
    tuttidClient,
    reporterService
  });
  registerWorkspaceFileManagerServices(registry, {
    hostFilesApi: desktopApi.host.files,
    tuttidClient,
    platformApi: desktopApi.platform,
    reporterService
  });
  registerRichTextAtServices(registry, {
    tuttidClient
  });
  const workspaceUserProjectService = registerWorkspaceUserProjectServices(
    registry,
    {
      hostFilesApi: desktopApi.host.files,
      tuttidClient,
      notifications: notificationService,
      platformApi: desktopApi.platform,
      workspaceId: environment.startupWorkspaceID ?? "__default__"
    }
  );
  registerWorkspaceAgentServices(registry, {
    eventStreamClient: tuttidEventStreamClient,
    hostFilesApi: desktopApi.host.files,
    tuttidClient,
    reporterService,
    runtimeApi: desktopApi.runtime,
    terminalCommandRunner: createAgentProviderTerminalCommandRunner(
      desktopApi.runtime
    ),
    workspaceUserProjectService
  });
  registerWorkspaceAppCenterServices(registry, {
    eventStreamClient: tuttidEventStreamClient,
    hostFilesApi: desktopApi.host.files,
    hostWorkspaceApi: desktopApi.host.workspace,
    tuttidClient,
    reporterService,
    runtimeApi: desktopApi.runtime
  });
  registerWorkspaceWorkbenchServices(registry, {
    browserApi: desktopApi.browser,
    developerApi: desktopApi.developer,
    dockPreviewCacheApi: desktopApi.dockPreviewCache,
    eventStreamClient: tuttidEventStreamClient,
    hostFilesApi: desktopApi.host.files,
    hostNotificationsApi: desktopApi.host.notifications,
    hostWindowApi: desktopApi.host.window,
    hostWorkspaceApi: desktopApi.host.workspace,
    tuttidClient,
    platformApi: desktopApi.platform,
    reporterService,
    runtimeApi: desktopApi.runtime,
    wallpaperApi: desktopApi.wallpaper
  });
  return {
    container: new InstantiationService(registry.makeCollection()),
    environmentMode: environment.mode,
    startupWorkspaceID: environment.startupWorkspaceID
  };
}
