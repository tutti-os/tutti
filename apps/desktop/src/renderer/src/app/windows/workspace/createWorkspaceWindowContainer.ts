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
import {
  createDesktopAgentSessionStatusViewResolver,
  registerRichTextAtServices
} from "@renderer/features/rich-text-at";
import { registerWorkspaceAgentServices } from "@renderer/features/workspace-agent";
import { registerWorkspaceAppCenterServices } from "@renderer/features/workspace-app-center";
import { registerWorkspaceCatalogServices } from "@renderer/features/workspace-catalog";
import { registerWorkspaceFileManagerServices } from "@renderer/features/workspace-file-manager";
import { registerWorkspaceUserProjectServices } from "@renderer/features/workspace-user-project";
import {
  createAgentProviderTerminalCommandRunner,
  registerWorkspaceWorkbenchServices
} from "@renderer/features/workspace-workbench";
import {
  managedAgentRoundedIconUrl,
  userAvatarPlaceholderUrl,
  workspaceAgentActivityStatusLabel
} from "@tutti-os/agent-gui/agent-message-center";
import { normalizeAgentActivityDisplayStatus } from "@tutti-os/agent-activity-core";
import { tuttiAgentAssetUrls } from "../../../../../shared/tuttiAssetProtocol.ts";
import { getActiveLocale } from "../../../i18n/runtime";
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
import type { DesktopWorkspaceAppExternalHostApi } from "@preload/types";

export interface WorkspaceWindowContainerResult {
  container: InstantiationService;
  environmentMode: "desktop" | "web";
  startupWorkspaceID: string | null;
  workspaceAppExternalApi?: DesktopWorkspaceAppExternalHostApi;
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
  const appCenterService = registerWorkspaceAppCenterServices(registry, {
    eventStreamClient: tuttidEventStreamClient,
    hostFilesApi: desktopApi.host.files,
    hostWorkspaceApi: desktopApi.host.workspace,
    tuttidClient,
    reporterService,
    runtimeApi: desktopApi.runtime
  });
  registerRichTextAtServices(registry, {
    tuttidClient,
    appCenterApps: () => appCenterService.store.apps,
    getLocale: getActiveLocale,
    resolveAgentIconUrl: resolveWorkspaceRichTextAgentIconUrl,
    userAvatarPlaceholderUrl,
    resolveSessionStatusView: createDesktopAgentSessionStatusViewResolver({
      normalizeDisplayStatus: normalizeAgentActivityDisplayStatus,
      statusLabel: workspaceAgentActivityStatusLabel
    })
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
  registerWorkspaceWorkbenchServices(registry, {
    browserApi: desktopApi.browser,
    computerUseApi: desktopApi.computerUse,
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
    startupWorkspaceID: environment.startupWorkspaceID,
    workspaceAppExternalApi: desktopApi.workspaceAppExternal
  };
}

function resolveWorkspaceRichTextAgentIconUrl(provider: string | undefined) {
  switch (normalizeWorkspaceRichTextAgentProvider(provider)) {
    case "claude-code":
      return tuttiAgentAssetUrls.claudeCode;
    case "codex":
      return tuttiAgentAssetUrls.codex;
    default:
      return managedAgentRoundedIconUrl(provider);
  }
}

function normalizeWorkspaceRichTextAgentProvider(
  provider: string | undefined
): string {
  const normalized =
    provider
      ?.trim()
      .toLowerCase()
      .replace(/[_\s]+/gu, "-") ?? "";
  switch (normalized) {
    case "claude":
    case "claude-code":
      return "claude-code";
    default:
      return normalized;
  }
}
