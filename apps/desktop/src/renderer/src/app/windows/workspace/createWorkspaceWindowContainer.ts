import { InstantiationService, ServiceRegistry } from "@tutti-os/infra/di";
import {
  isAnalyticsDebugAvailable,
  registerAnalyticsDebugServices
} from "@renderer/features/analytics-debug";
import {
  registerReporterServices,
  shouldReportPredefinePageview
} from "@renderer/features/analytics";
import { startPredefinePageviewAnalytics } from "@renderer/features/analytics/predefinePageviewAnalytics.ts";
import { registerAppUpdateServices } from "@renderer/features/app-update/services/registerAppUpdateServices";
import { registerDesktopPreferencesServices } from "@renderer/features/desktop-preferences/services/registerDesktopPreferencesServices.ts";
import { registerRichTextAtServices } from "@renderer/features/rich-text-at/services/registerRichTextAtServices";
import { createDesktopAgentSessionStatusViewResolver } from "@renderer/features/rich-text-at/providers/desktopAgentSessionStatusView.ts";
import { registerWorkspaceAgentServices } from "@renderer/features/workspace-agent/services/registerWorkspaceAgentServices";
import { requestWorkspaceAgentGuiLaunch } from "@renderer/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts";
import { startDesktopAgentAvailabilitySnapshotAnalytics } from "@renderer/features/workspace-agent/desktopAgentAvailabilitySnapshotAnalytics.ts";
import type { IAgentProviderStatusService as AgentProviderStatusService } from "@renderer/features/workspace-agent/services/agentProviderStatusService.interface.ts";
import type { IWorkspaceAgentActivityService as WorkspaceAgentActivityService } from "@renderer/features/workspace-agent/services/workspaceAgentActivityService.interface.ts";
import { registerWorkspaceAppCenterServices } from "@renderer/features/workspace-app-center/services/registerWorkspaceAppCenterServices";
import { registerWorkspaceCatalogServices } from "@renderer/features/workspace-catalog/services/registerWorkspaceCatalogServices";
import { registerWorkspaceFileManagerServices } from "@renderer/features/workspace-file-manager/services/registerWorkspaceFileManagerServices";
import { registerWorkspaceFilePreviewServices } from "@renderer/features/workspace-file-preview";
import { registerWorkspaceUserProjectServices } from "@renderer/features/workspace-user-project/services/registerWorkspaceUserProjectServices.ts";
import { createAgentProviderTerminalCommandRunner } from "@renderer/features/workspace-workbench/services/createAgentProviderTerminalCommandRunner";
import { createWorkspaceAgentOutcomeNotificationController } from "@renderer/features/workspace-workbench/services/workspaceAgentOutcomeNotification";
import {
  registerWorkspaceAccountService,
  registerWorkspaceWorkbenchServices
} from "@renderer/features/workspace-workbench/services/registerWorkspaceWorkbenchServices";
import { createWorkspaceWorkbenchSnapshotRepository } from "@renderer/features/workspace-workbench/services/createWorkspaceWorkbenchSnapshotRepository.ts";
import { createWorkspaceAgentOutcomeForegroundNotificationPresenter } from "@renderer/features/workspace-workbench/ui/WorkspaceAgentOutcomeNotificationToast";
import {
  managedAgentRoundedIconUrl,
  userAvatarPlaceholderUrl,
  workspaceAgentActivityStatusLabel
} from "@tutti-os/agent-gui/agent-message-center";
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
import { createWorkspaceWindowLifecycle } from "@renderer/lib/workspaceWindowLifecycle.ts";
import { resolveDesktopEnvironment } from "@renderer/platform/desktop/resolveDesktopEnvironment";
import { createDesktopTuttidEventStreamClient } from "@renderer/platform/tuttid/createDesktopTuttidEventStreamClient";
import { createDesktopTuttidClient } from "@renderer/platform/tuttid/createDesktopTuttidClient";
import { startDesktopDaemonConnectionAnalytics } from "@renderer/platform/tuttid/desktopDaemonConnectionAnalytics";
import type {
  DesktopHostWindowApi,
  DesktopRuntimeApi,
  DesktopWorkspaceAppExternalHostApi
} from "@preload/types";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { IReporterService } from "@renderer/features/analytics/services/reporterService.interface.ts";
import type { IDesktopRichTextAtService } from "@renderer/features/rich-text-at/services/richTextAtService.interface.ts";
import type { IWorkspaceUserProjectService } from "@renderer/features/workspace-user-project/services/workspaceUserProjectService.interface.ts";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center/services/workspaceAppCenterService.interface.ts";

const workspaceRendererInstanceId =
  createWorkspaceWindowInstanceId("workspace-renderer");
let activeWorkspaceWindowRuntimeCount = 0;

export interface WorkspaceWindowContainerResult {
  agentProviderStatusService: AgentProviderStatusService;
  container: InstantiationService;
  desktopApi: ReturnType<typeof resolveDesktopEnvironment>["desktopApi"];
  environmentMode: "desktop" | "web";
  eventStreamClient: TuttidEventStreamClient;
  hostWindowApi: DesktopHostWindowApi;
  reporterService: Pick<IReporterService, "trackEvents">;
  richTextAtService: IDesktopRichTextAtService;
  startupWorkspaceID: string | null;
  tuttidClient: TuttidClient;
  workspaceAgentActivityService: WorkspaceAgentActivityService;
  workspaceAppExternalApi?: DesktopWorkspaceAppExternalHostApi;
  workspaceAppCenterService: IWorkspaceAppCenterService;
  workspaceUserProjectService: IWorkspaceUserProjectService;
  dispose(): void;
  markCommitted(): void;
}

export function createWorkspaceWindowContainer(): WorkspaceWindowContainerResult {
  const environment = resolveDesktopEnvironment(window.tutti);
  const desktopApi = environment.desktopApi;
  const routeParameters = new URLSearchParams(window.location.search);
  const routeWorkspaceID = routeParameters.get("workspaceId");
  const activeWorkspaceID =
    routeWorkspaceID || environment.startupWorkspaceID || "__default__";
  const routeView = routeParameters.get("view") || "workspace";
  const runtimeInstanceId =
    createWorkspaceWindowInstanceId("workspace-runtime");
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
    tuttidClient,
    mode: routeView === "agent" ? "agent" : "os"
  });
  const reportPredefinePageview = shouldReportPredefinePageview(
    window.location.search
  );
  const windowLifecycle = createWorkspaceWindowLifecycle();
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
  const daemonConnectionAnalytics = startDesktopDaemonConnectionAnalytics({
    eventStreamClient: tuttidEventStreamClient,
    reporterService
  });
  let disposeAgentOutcomeNotificationController: (() => void) | null = null;
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
      eventStreamClient: tuttidEventStreamClient,
      logDiagnostic: (payload) => {
        void desktopApi.runtime.logTerminalDiagnostic({
          details: { payload: JSON.stringify(payload).slice(0, 1000) },
          event: "workspace.user-project.diagnostic",
          level: "debug",
          workspaceId: activeWorkspaceID
        });
      },
      notifications: notificationService,
      platformApi: desktopApi.platform,
      workspaceId: activeWorkspaceID
    }
  );
  registerWorkspaceFilePreviewServices(registry);
  registerWorkspaceFileManagerServices(registry, {
    desktopPreferencesService,
    hostFilesApi: desktopApi.host.files,
    tuttidClient,
    platformApi: desktopApi.platform,
    reporterService,
    workspaceUserProjectService
  });
  const accountService = registerWorkspaceAccountService(registry, {
    hostFilesApi: desktopApi.host.files,
    tuttidClient
  });
  const workspaceAgentServices = registerWorkspaceAgentServices(registry, {
    accountLogin: accountService,
    clipboard: {
      writeText: (text) => navigator.clipboard.writeText(text)
    },
    desktopPreferencesService,
    eventStreamClient: tuttidEventStreamClient,
    hostFilesApi: desktopApi.host.files,
    tuttidClient,
    notifications: notificationService,
    reporterService,
    runtimeApi: desktopApi.runtime,
    terminalCommandRunner: createAgentProviderTerminalCommandRunner(
      desktopApi.runtime
    ),
    windowLifecycle,
    workspaceId: activeWorkspaceID,
    workspaceUserProjectService
  });
  const predefinePageviewAnalytics = reportPredefinePageview
    ? startPredefinePageviewAnalytics({
        lifecycle: windowLifecycle,
        reporterService
      })
    : null;
  const agentAvailabilitySnapshotAnalytics = reportPredefinePageview
    ? startDesktopAgentAvailabilitySnapshotAnalytics({
        dependencies: { reporterService },
        lifecycle: windowLifecycle,
        readStatuses: workspaceAgentServices.readManagedAgentProviderStatuses,
        subscribeStatuses:
          workspaceAgentServices.subscribeManagedAgentProviderStatuses
      })
    : null;
  windowLifecycle.start();
  const agentOutcomeNotificationController =
    createWorkspaceAgentOutcomeNotificationController({
      foreground: createWorkspaceAgentOutcomeForegroundNotificationPresenter(),
      notifications: notificationService,
      translate,
      workspaceAgentActivityService:
        workspaceAgentServices.workspaceAgentActivityService,
      workspaceId: activeWorkspaceID,
      onNotificationEmitted(notification) {
        logWorkspaceWindowRuntimeDiagnostic(desktopApi.runtime, {
          details: {
            agentSessionId: notification.agentSessionId,
            provider: notification.provider,
            rendererInstanceId: workspaceRendererInstanceId,
            runtimeInstanceId,
            status: notification.status,
            turnId: notification.turnId,
            workspaceId: notification.workspaceId
          },
          event: "agent_outcome_notification.emitted"
        });
      }
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
    agentQuickPromptService: workspaceAgentServices.agentQuickPromptService,
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
    snapshotRepository: createWorkspaceWorkbenchSnapshotRepository({
      tuttidClient,
      windowSearch: window.location.search
    }),
    wallpaperApi: desktopApi.wallpaper,
    launchAgentGui: requestWorkspaceAgentGuiLaunch,
    onAgentTargetsChanged: async () => {
      await workspaceAgentServices.agentsService.refresh();
    }
  });
  const container = new InstantiationService(registry.makeCollection());
  let committed = false;
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    window.removeEventListener("beforeunload", dispose);
    logWorkspaceWindowRuntimeDiagnostic(desktopApi.runtime, {
      details: workspaceWindowRuntimeDiagnosticDetails({
        activeRuntimeCount: activeWorkspaceWindowRuntimeCount,
        rendererInstanceId: workspaceRendererInstanceId,
        routeView,
        runtimeInstanceId,
        workspaceId: activeWorkspaceID
      }),
      event: "workspace_runtime.dispose_started"
    });
    disposeAgentOutcomeNotificationController?.();
    disposeAgentOutcomeNotificationController = null;
    agentAvailabilitySnapshotAnalytics?.dispose();
    predefinePageviewAnalytics?.dispose();
    workspaceAgentServices.dispose();
    windowLifecycle.dispose();
    daemonConnectionAnalytics.release();
    container.dispose();
    tuttidEventStreamClient.dispose();
    activeWorkspaceWindowRuntimeCount = Math.max(
      0,
      activeWorkspaceWindowRuntimeCount - 1
    );
    logWorkspaceWindowRuntimeDiagnostic(desktopApi.runtime, {
      details: workspaceWindowRuntimeDiagnosticDetails({
        activeRuntimeCount: activeWorkspaceWindowRuntimeCount,
        rendererInstanceId: workspaceRendererInstanceId,
        routeView,
        runtimeInstanceId,
        workspaceId: activeWorkspaceID
      }),
      event: "workspace_runtime.disposed"
    });
  };
  const markCommitted = () => {
    if (committed || disposed) {
      return;
    }
    committed = true;
    logWorkspaceWindowRuntimeDiagnostic(desktopApi.runtime, {
      details: workspaceWindowRuntimeDiagnosticDetails({
        activeRuntimeCount: activeWorkspaceWindowRuntimeCount,
        rendererInstanceId: workspaceRendererInstanceId,
        routeView,
        runtimeInstanceId,
        workspaceId: activeWorkspaceID
      }),
      event: "workspace_runtime.committed"
    });
  };
  activeWorkspaceWindowRuntimeCount += 1;
  window.addEventListener("beforeunload", dispose);
  const runtimeDetails = workspaceWindowRuntimeDiagnosticDetails({
    activeRuntimeCount: activeWorkspaceWindowRuntimeCount,
    rendererInstanceId: workspaceRendererInstanceId,
    routeView,
    runtimeInstanceId,
    workspaceId: activeWorkspaceID
  });
  logWorkspaceWindowRuntimeDiagnostic(desktopApi.runtime, {
    details: runtimeDetails,
    event: "workspace_runtime.created"
  });
  if (activeWorkspaceWindowRuntimeCount > 1) {
    logWorkspaceWindowRuntimeDiagnostic(desktopApi.runtime, {
      details: runtimeDetails,
      event: "workspace_runtime.duplicate_detected",
      level: "warn"
    });
  }
  return {
    agentProviderStatusService:
      workspaceAgentServices.agentProviderStatusService,
    container,
    desktopApi,
    environmentMode: environment.mode,
    eventStreamClient: tuttidEventStreamClient,
    hostWindowApi: desktopApi.host.window,
    reporterService,
    richTextAtService,
    startupWorkspaceID: environment.startupWorkspaceID,
    tuttidClient,
    workspaceAgentActivityService:
      workspaceAgentServices.workspaceAgentActivityService,
    workspaceAppCenterService,
    workspaceAppExternalApi: desktopApi.workspaceAppExternal,
    workspaceUserProjectService,
    dispose,
    markCommitted
  };
}

function createWorkspaceWindowInstanceId(prefix: string): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function workspaceWindowRuntimeDiagnosticDetails(input: {
  activeRuntimeCount: number;
  rendererInstanceId: string;
  routeView: string;
  runtimeInstanceId: string;
  workspaceId: string;
}): Record<string, unknown> {
  return {
    activeRuntimeCount: input.activeRuntimeCount,
    rendererInstanceId: input.rendererInstanceId,
    routeView: input.routeView,
    runtimeInstanceId: input.runtimeInstanceId,
    workspaceId: input.workspaceId
  };
}

function logWorkspaceWindowRuntimeDiagnostic(
  runtimeApi: Pick<DesktopRuntimeApi, "logRendererDiagnostic">,
  input: {
    details: Record<string, unknown>;
    event: string;
    level?: "warn";
  }
): void {
  void runtimeApi
    .logRendererDiagnostic({
      details: input.details,
      event: input.event,
      ...(input.level ? { level: input.level } : {}),
      source: "workspace-window-runtime"
    })
    .catch(() => {});
}

function resolveWorkspaceRichTextAgentIconUrl(provider: string | undefined) {
  return managedAgentRoundedIconUrl(provider);
}
