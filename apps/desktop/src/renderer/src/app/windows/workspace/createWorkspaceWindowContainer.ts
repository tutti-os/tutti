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
import { subscribe } from "valtio";
import {
  createDesktopAgentSessionStatusViewResolver,
  registerRichTextAtServices
} from "@renderer/features/rich-text-at";
import {
  registerWorkspaceAgentServices,
  type AgentProviderStatusService,
  type WorkspaceAgentActivityService
} from "@renderer/features/workspace-agent";
import { registerWorkspaceAppCenterServices } from "@renderer/features/workspace-app-center";
import { registerWorkspaceCatalogServices } from "@renderer/features/workspace-catalog";
import { registerWorkspaceFileManagerServices } from "@renderer/features/workspace-file-manager";
import { registerWorkspaceUserProjectServices } from "@renderer/features/workspace-user-project";
import {
  createAgentProviderTerminalCommandRunner,
  createWorkspaceAgentOutcomeForegroundNotificationPresenter,
  createWorkspaceAgentOutcomeNotificationController,
  registerWorkspaceWorkbenchServices
} from "@renderer/features/workspace-workbench";
import {
  managedAgentRoundedIconUrl,
  userAvatarPlaceholderUrl,
  workspaceAgentActivityStatusLabel
} from "@tutti-os/agent-gui/agent-message-center";
import { resolveProviderIconAsset } from "@tutti-os/agent-gui/provider-icons";
import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";
import { normalizeAgentActivityDisplayStatus } from "@tutti-os/agent-activity-core";
import { translate } from "../../../i18n";
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
import type {
  DesktopHostWindowApi,
  DesktopWorkspaceAppExternalHostApi
} from "@preload/types";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { IReporterService } from "@renderer/features/analytics";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at";
import type { IWorkspaceUserProjectService } from "@renderer/features/workspace-user-project";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";

export interface WorkspaceWindowContainerResult {
  agentProviderStatusService: AgentProviderStatusService;
  container: InstantiationService;
  desktopApi: ReturnType<typeof resolveDesktopEnvironment>["desktopApi"];
  environmentMode: "desktop" | "web";
  hostWindowApi: DesktopHostWindowApi;
  reporterService: Pick<IReporterService, "trackEvents">;
  richTextAtService: IDesktopRichTextAtService;
  startupWorkspaceID: string | null;
  tuttidClient: TuttidClient;
  workspaceAgentActivityService: WorkspaceAgentActivityService;
  workspaceAppExternalApi?: DesktopWorkspaceAppExternalHostApi;
  workspaceAppCenterService: IWorkspaceAppCenterService;
  workspaceUserProjectService: IWorkspaceUserProjectService;
}

export function createWorkspaceWindowContainer(): WorkspaceWindowContainerResult {
  const environment = resolveDesktopEnvironment(window.tutti);
  const desktopApi = environment.desktopApi;
  const routeWorkspaceID = new URLSearchParams(window.location.search).get(
    "workspaceId"
  );
  const activeWorkspaceID =
    routeWorkspaceID || environment.startupWorkspaceID || "__default__";
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
  const desktopPreferencesService = registerDesktopPreferencesServices(
    registry,
    tuttidClient,
    tuttidEventStreamClient
  );
  // Preview agents are feature-gated behind Developer-panel preferences
  // preference: gated providers render as coming-soon placeholders in the
  // AgentGUI rail (like hermes) and stay hidden from dock/mention/manage.
  const isAgentProviderGated = (provider: string): boolean => {
    const gate =
      resolveAgentGUIProviderCatalogIdentity(provider)?.desktop.visibilityGate;
    switch (gate) {
      case "cursor_preview":
        return !desktopPreferencesService.store.enableCursorAgent;
      case "opencode_preview":
        return !desktopPreferencesService.store.enableOpenCodeAgent;
      default:
        return false;
    }
  };
  const subscribeAgentProviderVisibility = (
    listener: () => void
  ): (() => void) => {
    let enableCursorAgent = desktopPreferencesService.store.enableCursorAgent;
    let enableOpenCodeAgent =
      desktopPreferencesService.store.enableOpenCodeAgent;
    return subscribe(desktopPreferencesService.store, () => {
      const nextEnableCursorAgent =
        desktopPreferencesService.store.enableCursorAgent;
      const nextEnableOpenCodeAgent =
        desktopPreferencesService.store.enableOpenCodeAgent;
      if (
        nextEnableCursorAgent === enableCursorAgent &&
        nextEnableOpenCodeAgent === enableOpenCodeAgent
      ) {
        return;
      }
      enableCursorAgent = nextEnableCursorAgent;
      enableOpenCodeAgent = nextEnableOpenCodeAgent;
      listener();
    });
  };
  const daemonConnectionAnalytics = startDesktopDaemonConnectionAnalytics({
    eventStreamClient: tuttidEventStreamClient,
    reporterService
  });
  let disposeAgentOutcomeNotificationController: (() => void) | null = null;
  let disposeAgentProviderVisibilityRefresh: (() => void) | null = null;
  let releasedWindowAnalytics = false;
  const releaseWindowAnalytics = () => {
    if (releasedWindowAnalytics) {
      return;
    }
    releasedWindowAnalytics = true;
    window.removeEventListener("beforeunload", releaseWindowAnalytics);
    disposeAgentOutcomeNotificationController?.();
    disposeAgentOutcomeNotificationController = null;
    disposeAgentProviderVisibilityRefresh?.();
    disposeAgentProviderVisibilityRefresh = null;
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
  const workspaceAppCenterService = registerWorkspaceAppCenterServices(
    registry,
    {
      eventStreamClient: tuttidEventStreamClient,
      hostFilesApi: desktopApi.host.files,
      hostWorkspaceApi: desktopApi.host.workspace,
      tuttidClient,
      reporterService,
      runtimeApi: desktopApi.runtime
    }
  );
  const workspaceUserProjectService = registerWorkspaceUserProjectServices(
    registry,
    {
      hostFilesApi: desktopApi.host.files,
      tuttidClient,
      notifications: notificationService,
      platformApi: desktopApi.platform,
      workspaceId: activeWorkspaceID
    }
  );
  registerWorkspaceFileManagerServices(registry, {
    desktopPreferencesService,
    hostFilesApi: desktopApi.host.files,
    tuttidClient,
    platformApi: desktopApi.platform,
    reporterService,
    workspaceUserProjectService
  });
  const workspaceAgentServices = registerWorkspaceAgentServices(registry, {
    eventStreamClient: tuttidEventStreamClient,
    hostFilesApi: desktopApi.host.files,
    tuttidClient,
    notifications: notificationService,
    reporterService,
    runtimeApi: desktopApi.runtime,
    resolveAgentTargetIconUrl: resolveWorkspaceAgentTargetIconUrl,
    isAgentTargetProviderGated: isAgentProviderGated,
    terminalCommandRunner: createAgentProviderTerminalCommandRunner(
      desktopApi.runtime
    ),
    workspaceUserProjectService
  });
  disposeAgentProviderVisibilityRefresh = subscribeAgentProviderVisibility(
    () => {
      void workspaceAgentServices.agentsService.refresh().catch(() => {});
    }
  );
  const agentOutcomeNotificationController =
    createWorkspaceAgentOutcomeNotificationController({
      foreground: createWorkspaceAgentOutcomeForegroundNotificationPresenter(),
      notifications: notificationService,
      translate,
      workspaceAgentActivityService:
        workspaceAgentServices.workspaceAgentActivityService,
      workspaceId: activeWorkspaceID
    });
  disposeAgentOutcomeNotificationController = () => {
    agentOutcomeNotificationController.dispose();
  };
  const richTextAtService = registerRichTextAtServices(registry, {
    agentsService: workspaceAgentServices.agentsService,
    tuttidClient,
    getLocale: getActiveLocale,
    resolveAgentIconUrl: resolveWorkspaceRichTextAgentIconUrl,
    userAvatarPlaceholderUrl,
    resolveSessionStatusView: createDesktopAgentSessionStatusViewResolver({
      normalizeDisplayStatus: normalizeAgentActivityDisplayStatus,
      statusLabel: workspaceAgentActivityStatusLabel
    }),
    agentProviderStatuses: () => {
      const snapshot =
        workspaceAgentServices.agentProviderStatusService.getSnapshot();
      return snapshot.capturedAt === null ? undefined : snapshot.statuses;
    }
  });
  registerWorkspaceWorkbenchServices(registry, {
    browserApi: desktopApi.browser,
    isAgentProviderHidden: isAgentProviderGated,
    subscribeAgentProviderVisibility,
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
    wallpaperApi: desktopApi.wallpaper,
    onAgentTargetsChanged: async () => {
      await workspaceAgentServices.agentsService.refresh();
    }
  });
  return {
    agentProviderStatusService:
      workspaceAgentServices.agentProviderStatusService,
    container: new InstantiationService(registry.makeCollection()),
    desktopApi,
    environmentMode: environment.mode,
    hostWindowApi: desktopApi.host.window,
    reporterService,
    richTextAtService,
    startupWorkspaceID: environment.startupWorkspaceID,
    tuttidClient,
    workspaceAgentActivityService:
      workspaceAgentServices.workspaceAgentActivityService,
    workspaceAppCenterService,
    workspaceAppExternalApi: desktopApi.workspaceAppExternal,
    workspaceUserProjectService
  };
}

function resolveWorkspaceRichTextAgentIconUrl(provider: string | undefined) {
  const identity = resolveAgentGUIProviderCatalogIdentity(provider);
  return (
    resolveProviderIconAsset(identity?.iconKey, "rounded") ??
    managedAgentRoundedIconUrl(provider)
  );
}

function resolveWorkspaceAgentTargetIconUrl(identity: {
  iconKey: string | null;
  provider: string;
}): string {
  if (identity.iconKey) {
    return (
      resolveProviderIconAsset(identity.iconKey, "rounded") ??
      managedAgentRoundedIconUrl(undefined)
    );
  }
  return resolveWorkspaceRichTextAgentIconUrl(identity.provider);
}
