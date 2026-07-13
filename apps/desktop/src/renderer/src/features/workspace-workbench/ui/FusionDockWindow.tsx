import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from "react";
import {
  Button,
  CloseIcon,
  ConfirmationDialog,
  Input,
  SearchIcon
} from "@tutti-os/ui-system";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import type {
  WorkbenchHostDockEntry,
  WorkbenchHostDockEntryDynamicState,
  WorkbenchHostDockEntryStateSource
} from "@tutti-os/workbench-surface";
import type { DesktopApi } from "@preload/types";
import {
  desktopFusionDockLayout,
  type DesktopFusionState,
  type DesktopFusionWindowDescriptor
} from "@shared/contracts/fusion.ts";
import { useTranslation } from "@renderer/i18n";
import {
  findWorkspaceApp,
  useWorkspaceAppCenterService,
  WorkspaceAppCenterIntegration
} from "@renderer/features/workspace-app-center";
import { AppUpdateStatus } from "@renderer/features/app-update";
import { useWorkspaceCatalogService } from "@renderer/features/workspace-catalog";
import {
  ensureAllDesktopManagedAgentProviderStatuses,
  IAgentProviderStatusService
} from "@renderer/features/workspace-agent";
import { useService } from "@tutti-os/infra/di";
import {
  createFusionSearchItems,
  fusionKindLabelKey,
  resolveFusionSearchEnterAction,
  shouldShowFusionWorkspaceContext,
  type FusionSearchItem
} from "../services/fusionDockViewModel.ts";
import {
  isFusionDockLauncherBlocked,
  resolveFusionDockLaunchers,
  type FusionDockLauncher
} from "../services/fusionDockLauncherModel.ts";
import type { FusionDockLauncherOpenInput } from "../services/fusionDockService.interface.ts";
import { useFusionDockController } from "../services/useFusionDockController.ts";
import { startFusionDockAgentBridge } from "../services/fusionDockAgentBridge.ts";
import { resolveFusionDockAgentNotificationWorkspaceIds } from "../services/fusionDockAgentNotificationOwners.ts";
import { useStandaloneFusionLaunchCoordinators } from "../services/useStandaloneFusionLaunchCoordinators.ts";
import type { FusionNativeLaunchAdapter } from "../services/fusionNativeLaunchAdapter.ts";
import { resolveWorkspaceDockLauncherCatalog } from "../services/workspaceDockLauncherCatalog.ts";
import type { WorkspaceWorkbenchHostSessionBinding } from "../services/workspaceWorkbenchHostService.interface.ts";
import { FusionSearchResults, shortcutErrorKey } from "./FusionDockLists.tsx";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService.ts";
import { useWorkspaceWorkbenchShellRuntime } from "./useWorkspaceWorkbenchShellRuntime.tsx";
import { FusionDockAgentNotificationOwners } from "./FusionDockAgentNotificationOwners.tsx";
import { FusionLauncherRail } from "./FusionLauncherRail.tsx";

interface FusionDockWindowProps {
  desktopApi: DesktopApi;
  workspaceId: string;
}

export function FusionDockWindow({
  desktopApi,
  workspaceId
}: FusionDockWindowProps): ReactNode {
  const { t } = useTranslation();
  const agentProviderStatusService = useService(IAgentProviderStatusService);
  const { service: appCenterService } = useWorkspaceAppCenterService();
  const { service: workspaceCatalogService, state: workspaceCatalogState } =
    useWorkspaceCatalogService();
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const { service: controller, state: controllerState } =
    useFusionDockController();
  const fusionLaunch = useStandaloneFusionLaunchCoordinators({
    appCenterService,
    desktopApi,
    includeWorkbenchNodeHandler: true,
    workbenchHostService,
    workspaceId
  });

  useEffect(() => {
    void workspaceCatalogService.loadWorkspaceWindow(
      workspaceId,
      "fusion-dock"
    );
  }, [workspaceCatalogService, workspaceId]);
  useEffect(
    () =>
      startFusionDockAgentBridge({
        agentProviderStatusService,
        fusionApi: desktopApi.fusion,
        onNavigationError(error, payload) {
          void desktopApi.runtime
            .logRendererDiagnostic({
              details: {
                agentSessionId: payload.agentSessionId,
                error: fusionNavigationErrorMessage(error),
                provider: payload.provider
              },
              event: "fusion.notification_navigation.failed",
              level: "error",
              source: "fusion-dock",
              workspaceId: payload.workspaceId
            })
            .catch(() => undefined);
        },
        workbenchHostService
      }),
    [
      agentProviderStatusService,
      desktopApi.fusion,
      desktopApi.runtime,
      workbenchHostService
    ]
  );
  useEffect(() => {
    void ensureAllDesktopManagedAgentProviderStatuses(
      agentProviderStatusService
    );
  }, [agentProviderStatusService]);
  useFusionWorkspaceAppWindowBinding({
    appCenterService,
    controller,
    fusionLaunch,
    windows: controllerState.windows
  });

  const agentNotificationWorkspaceIds = useMemo(
    () =>
      resolveFusionDockAgentNotificationWorkspaceIds({
        currentWorkspaceId: workspaceId,
        resources: controllerState.resources,
        windows: controllerState.windows
      }),
    [controllerState.resources, controllerState.windows, workspaceId]
  );
  const workspace =
    workspaceCatalogState.status === "ready" &&
    workspaceCatalogState.workspace?.id === workspaceId
      ? (workspaceCatalogState.workspace as WorkspaceSummary)
      : null;

  return (
    <main
      className="flex h-screen min-h-0 justify-center overflow-hidden bg-transparent p-2 text-[var(--text-primary)] [-webkit-app-region:drag]"
      data-fusion-dock-window="true"
    >
      <WorkspaceAppCenterIntegration workspaceId={workspaceId} />
      <FusionDockAgentNotificationOwners
        fusionApi={desktopApi.fusion}
        workspaceIds={agentNotificationWorkspaceIds}
      />
      {workspace ? (
        <ReadyFusionDockWindow
          controllerState={controllerState}
          desktopApi={desktopApi}
          fusionLaunch={fusionLaunch}
          workspace={workspace}
        />
      ) : (
        <FusionDockSurface
          controllerState={controllerState}
          fusionLaunch={fusionLaunch}
          launchers={[]}
          workspaceId={workspaceId}
        />
      )}
      <ConfirmationDialog
        cancelLabel={t("workspace.workbenchDesktop.closeGuard.cancel")}
        confirmLabel={t("workspace.workbenchDesktop.closeGuard.confirm")}
        description={t("workspace.workbenchDesktop.closeGuard.description")}
        open={controllerState.pendingTerminalStop !== null}
        title={t("workspace.workbenchDesktop.closeGuard.title")}
        tone="destructive"
        onConfirm={() => void controller.confirmPendingTerminalStop()}
        onOpenChange={(open) => {
          if (!open) {
            controller.dismissPendingTerminalStop();
          }
        }}
      >
        {controllerState.pendingTerminalStop?.details ? (
          <div className="whitespace-pre-wrap">
            {controllerState.pendingTerminalStop.details}
          </div>
        ) : null}
      </ConfirmationDialog>
    </main>
  );
}

function ReadyFusionDockWindow({
  controllerState,
  desktopApi,
  fusionLaunch,
  workspace
}: {
  controllerState: ReturnType<typeof useFusionDockController>["state"];
  desktopApi: DesktopApi;
  fusionLaunch: FusionNativeLaunchAdapter;
  workspace: WorkspaceSummary;
}): ReactNode {
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const [hostSession, setHostSession] =
    useState<WorkspaceWorkbenchHostSessionBinding | null>(null);

  useLayoutEffect(() => {
    const binding = workbenchHostService.openHostSession(workspace.id);
    setHostSession(binding);
    return () => binding.release();
  }, [workbenchHostService, workspace.id]);

  if (!hostSession?.isActive || hostSession.workspaceId !== workspace.id) {
    return (
      <FusionDockSurface
        controllerState={controllerState}
        fusionLaunch={fusionLaunch}
        launchers={[]}
        workspaceId={workspace.id}
      />
    );
  }

  return (
    <ReadyFusionDockWindowWithSession
      controllerState={controllerState}
      desktopApi={desktopApi}
      fusionLaunch={fusionLaunch}
      hostSession={hostSession}
      workspace={workspace}
    />
  );
}

function ReadyFusionDockWindowWithSession({
  controllerState,
  desktopApi,
  fusionLaunch,
  hostSession,
  workspace
}: {
  controllerState: ReturnType<typeof useFusionDockController>["state"];
  desktopApi: DesktopApi;
  fusionLaunch: FusionNativeLaunchAdapter;
  hostSession: WorkspaceWorkbenchHostSessionBinding;
  workspace: WorkspaceSummary;
}): ReactNode {
  const { state: appCenterState } = useWorkspaceAppCenterService();
  const runtime = useWorkspaceWorkbenchShellRuntime({
    enableWindowCloseGuard: false,
    hostSession,
    state: { platform: desktopApi.platform.os, workspace }
  });
  const dockStateRevision = useWorkbenchDockStateRevision(
    runtime.hostInput.dockStateSource
  );
  const appInstallationById = useMemo(
    () =>
      new Map(
        appCenterState.apps.map((app) => [app.appId, app.installed] as const)
      ),
    [appCenterState.apps]
  );
  const dockEntries = useMemo(
    () =>
      resolveWorkspaceDockLauncherCatalog({
        contributions: runtime.hostInput.contributions,
        dockEntries: runtime.hostInput.dockEntries,
        isWorkspaceAppInstalled: (appId) => appInstallationById.get(appId)
      }),
    [
      appInstallationById,
      runtime.hostInput.contributions,
      runtime.hostInput.dockEntries
    ]
  );
  const dynamicStateByEntryId = useMemo(
    () =>
      readWorkbenchDockDynamicStates(
        dockEntries,
        runtime.hostInput.dockStateSource
      ),
    [dockEntries, dockStateRevision, runtime.hostInput.dockStateSource]
  );
  const launchers = useMemo(
    () =>
      resolveFusionDockLaunchers({
        dockEntries,
        dynamicStateByEntryId,
        resources: controllerState.resources,
        windows: controllerState.windows,
        workspaceId: workspace.id
      }),
    [
      controllerState.resources,
      controllerState.windows,
      dockEntries,
      dynamicStateByEntryId,
      workspace.id
    ]
  );

  return (
    <FusionDockSurface
      controllerState={controllerState}
      fusionLaunch={fusionLaunch}
      launchers={launchers}
      workspaceId={workspace.id}
    />
  );
}

function FusionDockSurface({
  controllerState,
  fusionLaunch,
  launchers,
  workspaceId
}: {
  controllerState: ReturnType<typeof useFusionDockController>["state"];
  fusionLaunch: FusionNativeLaunchAdapter;
  launchers: readonly FusionDockLauncher[];
  workspaceId: string;
}): ReactNode {
  const { t } = useTranslation();
  const { service: appCenterService } = useWorkspaceAppCenterService();
  const { service: controller } = useFusionDockController();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const searchExpanded = controllerState.fusionState.dockSearchExpanded;
  const searchScope = readFusionDockSearchScope(controllerState.fusionState);

  useEffect(() => {
    setQuery("");
    setSelectedIndex(0);
    if (!searchExpanded) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searchExpanded, searchScope]);

  const searchItems = useMemo(
    () =>
      createFusionSearchItems({
        launchers,
        query,
        resources: controllerState.resources,
        scope: searchScope,
        settingsLabel: t(fusionKindLabelKey("settings")),
        t,
        windows: controllerState.windows,
        workspaceNameById: controllerState.workspaceNameById
      }),
    [
      controllerState.resources,
      controllerState.windows,
      controllerState.workspaceNameById,
      launchers,
      query,
      searchScope,
      t
    ]
  );
  const showWorkspaceContext = useMemo(
    () =>
      shouldShowFusionWorkspaceContext({
        currentWorkspaceId: workspaceId,
        resources: controllerState.resources,
        windows: controllerState.windows
      }),
    [controllerState.resources, controllerState.windows, workspaceId]
  );

  useEffect(() => {
    setSelectedIndex((current) =>
      Math.min(current, Math.max(0, searchItems.length - 1))
    );
  }, [searchItems.length]);

  const openSettings = useCallback(
    (forceNew = false) => {
      const input: FusionDockLauncherOpenInput = {
        kind: "settings",
        title: t(fusionKindLabelKey("settings")),
        workspaceId
      };
      return forceNew
        ? controller.openLauncherInNewWindow(input)
        : controller.activateLauncher(input);
    },
    [controller, t, workspaceId]
  );
  const activateLauncher = useCallback(
    async (launcher: FusionDockLauncher, forceNew = false) => {
      if (isFusionDockLauncherBlocked(launcher)) {
        return;
      }
      if (launcher.kind === "workspace-app" && launcher.resourceId) {
        if (!forceNew) {
          await appCenterService.openApp({
            appId: launcher.resourceId,
            workspaceId: launcher.workspaceId
          });
          return;
        }
        const previousApp = findWorkspaceApp(
          appCenterService,
          launcher.resourceId
        );
        const preparedApp = await appCenterService.prepareAppLaunch({
          appId: launcher.resourceId,
          workspaceId: launcher.workspaceId
        });
        if (!preparedApp) {
          return;
        }
        await fusionLaunch.openWorkspaceApp({
          appId: launcher.resourceId,
          forceNew: true,
          ...(readWorkspaceAppIntent(launcher.entry.launchPayload) !== undefined
            ? {
                intent: readWorkspaceAppIntent(launcher.entry.launchPayload)
              }
            : {}),
          prepared: true,
          prevStatus: previousApp?.runtimeStatus ?? preparedApp.runtimeStatus
        });
        return;
      }
      const input = createFusionDockLauncherOpenInput(launcher, forceNew);
      await (forceNew
        ? controller.openLauncherInNewWindow(input)
        : controller.activateLauncher(input));
    },
    [appCenterService, controller, fusionLaunch]
  );
  const activateSearchItem = useCallback(
    (item: FusionSearchItem | undefined, forceNew = false) => {
      if (!item) {
        return;
      }
      if (item.kind === "launcher") {
        void activateLauncher(item.launcher, forceNew);
      } else if (item.kind === "command") {
        void openSettings(forceNew);
      } else if (forceNew) {
        if (item.kind === "resource") {
          void controller.openResourceInNewWindow(item.resource);
        } else {
          void controller.openWindowInNewWindow(item.window);
        }
      } else if (item.kind === "window") {
        void controller.focusWindow(item.window.windowInstanceId);
      } else {
        void controller.focusOrReconnectResource(item.resource);
      }
    },
    [activateLauncher, controller, openSettings]
  );
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) =>
        searchItems.length === 0 ? 0 : (current + 1) % searchItems.length
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) =>
        searchItems.length === 0
          ? 0
          : (current - 1 + searchItems.length) % searchItems.length
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      activateSearchItem(
        searchItems[selectedIndex],
        resolveFusionSearchEnterAction(event) === "new"
      );
    } else if (event.key === "Escape") {
      event.preventDefault();
      void controller.hideDock();
    }
  };

  return (
    <section
      className="flex min-h-0 shrink-0 overflow-hidden rounded-[18px] border border-[color-mix(in_srgb,var(--border-1)_55%,transparent)] bg-[color-mix(in_srgb,var(--background-fronted)_94%,transparent)] shadow-panel backdrop-blur-xl"
      style={{
        width: searchExpanded ? "100%" : desktopFusionDockLayout.panelWidthPx
      }}
    >
      <FusionLauncherRail
        actionError={controllerState.actionError}
        launchers={launchers}
        resources={controllerState.resources}
        shortcutError={controllerState.fusionState.shortcut.error}
        windows={controllerState.windows}
        workspaceId={workspaceId}
        onActivate={activateLauncher}
        onHide={() => void controller.hideDock()}
        onOpenSettings={() => void openSettings()}
      />
      {searchExpanded ? (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-l border-[var(--border-1)]">
          <div className="flex items-center gap-2 border-b border-[var(--border-1)] p-2.5">
            <SearchIcon
              aria-hidden
              className="ml-1 shrink-0 text-[var(--text-tertiary)]"
              size={16}
            />
            <Input
              ref={searchRef}
              aria-description={t("workspace.fusion.newWindowShortcutHint")}
              aria-label={t("workspace.fusion.searchLabel")}
              data-fusion-search-input="true"
              className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 shadow-none [-webkit-app-region:no-drag] focus-visible:ring-0"
              placeholder={
                searchScope === "background-tasks"
                  ? t("workspace.fusion.backgroundTasks")
                  : t("workspace.fusion.searchPlaceholder")
              }
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelectedIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
            />
            <div className="max-w-28 overflow-hidden [-webkit-app-region:no-drag]">
              <AppUpdateStatus density="compact" />
            </div>
            <Button
              aria-label={t("workspace.fusion.hideDock")}
              className="size-7 p-0 [-webkit-app-region:no-drag]"
              size="icon"
              variant="ghost"
              onClick={() => void controller.hideDock()}
            >
              <CloseIcon size={14} />
            </Button>
          </div>

          {controllerState.fusionState.shortcut.error ? (
            <p className="m-0 border-b border-[var(--border-1)] px-3 py-2 text-xs text-[var(--state-danger)]">
              {t(shortcutErrorKey(controllerState.fusionState.shortcut.error))}
            </p>
          ) : null}
          {controllerState.actionError ? (
            <p className="m-0 border-b border-[var(--border-1)] px-3 py-2 text-xs text-[var(--state-danger)]">
              {t("workspace.fusion.actionFailed")}
            </p>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto p-2 [-webkit-app-region:no-drag]">
            <FusionSearchResults
              items={searchItems}
              selectedIndex={selectedIndex}
              showWorkspaceContext={showWorkspaceContext}
              t={t}
              workspaceNameById={controllerState.workspaceNameById}
              onActivate={activateSearchItem}
              onCloseWindow={(window) =>
                void controller.closeWindow(window.windowInstanceId)
              }
              onStopResource={(resource) =>
                void controller.stopResource(resource)
              }
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function useFusionWorkspaceAppWindowBinding(input: {
  appCenterService: ReturnType<typeof useWorkspaceAppCenterService>["service"];
  controller: ReturnType<typeof useFusionDockController>["service"];
  fusionLaunch: FusionNativeLaunchAdapter;
  windows: readonly DesktopFusionWindowDescriptor[];
}): void {
  const windowsRef = useRef(input.windows);
  windowsRef.current = input.windows;

  useEffect(() => {
    input.appCenterService.setWorkspaceAppLauncher(async (request) =>
      input.fusionLaunch.openWorkspaceApp({
        appId: request.appId,
        forceNew: false,
        ...(request.intent ? { intent: request.intent } : {}),
        prepared: request.prepared,
        ...(request.prevStatus ? { prevStatus: request.prevStatus } : {})
      })
    );
    input.appCenterService.setWorkspaceAppViewCloser((request) => {
      for (const window of windowsRef.current) {
        if (
          window.workspaceId === request.workspaceId &&
          window.kind === "workspace-app" &&
          window.resourceId === request.appId
        ) {
          void input.controller.closeWindow(window.windowInstanceId);
        }
      }
    });
    input.appCenterService.setWorkspaceAppViewOpenChecker((request) =>
      windowsRef.current.some(
        (window) =>
          window.workspaceId === request.workspaceId &&
          window.kind === "workspace-app" &&
          window.resourceId === request.appId
      )
    );
    return () => {
      input.appCenterService.setWorkspaceAppLauncher(null);
      input.appCenterService.setWorkspaceAppViewCloser(null);
      input.appCenterService.setWorkspaceAppViewOpenChecker(null);
    };
  }, [input.appCenterService, input.controller, input.fusionLaunch]);
}

function useWorkbenchDockStateRevision(
  source: WorkbenchHostDockEntryStateSource | undefined
): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!source) {
      return;
    }
    return source.subscribe(() => setRevision((current) => current + 1));
  }, [source]);
  return revision;
}

function readWorkbenchDockDynamicStates(
  entries: readonly WorkbenchHostDockEntry[],
  source: WorkbenchHostDockEntryStateSource | undefined
): Readonly<
  Record<string, WorkbenchHostDockEntryDynamicState | null | undefined>
> {
  if (!source) {
    return {};
  }
  return Object.fromEntries(
    entries.map((entry) => [entry.id, source.getEntryState(entry.id)])
  );
}

function createFusionDockLauncherOpenInput(
  launcher: FusionDockLauncher,
  forceNew: boolean
): FusionDockLauncherOpenInput {
  return {
    kind: launcher.kind,
    launchPayload: forceNew
      ? (launcher.entry.newWindowLaunchPayload ?? launcher.entry.launchPayload)
      : launcher.entry.launchPayload,
    ...(launcher.resourceId ? { resourceId: launcher.resourceId } : {}),
    title: launcher.entry.label,
    workspaceId: launcher.workspaceId
  };
}

function readWorkspaceAppIntent(payload: unknown): unknown {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { intent?: unknown }).intent
    : undefined;
}

function readFusionDockSearchScope(
  state: DesktopFusionState
): "all" | "background-tasks" {
  const scope = state.dockSearchScope;
  return scope === "background-tasks" ? scope : "all";
}

function fusionNavigationErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    return "Unknown navigation error";
  }
}
