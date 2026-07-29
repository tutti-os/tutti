import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from "react";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import {
  buildWorkbenchLaunchpadItems,
  WorkbenchLaunchpadOverlay as SharedWorkbenchLaunchpadOverlay,
  type WorkbenchLaunchpadAgentDescriptor,
  type WorkbenchLaunchpadItem
} from "@tutti-os/workbench-launchpad";
import type {
  WorkbenchDockPlacement,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import { defaultIssueManagerWorkbenchTypeId } from "@tutti-os/workspace-issue-manager/workbench";
import type { DesktopDockIconStyle } from "@shared/preferences";
import type { DesktopThemeAppearance } from "@shared/theme";
import { useService } from "@tutti-os/infra/di";
import { IAgentProviderStatusService } from "@renderer/features/workspace-agent/services/agentProviderStatusService.interface.ts";
import { requestWorkspaceAgentGuiLaunch } from "@renderer/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts";
import { IReporterService } from "@renderer/features/analytics";
import { normalizeDesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState";
import {
  shouldShowWorkspaceApp,
  useWorkspaceAppCenterService,
  workspaceAppCenterNodeID
} from "@renderer/features/workspace-app-center";
import { useTranslation } from "@renderer/i18n";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService.ts";
import {
  isWorkspaceAgentGuiComingSoonProvider,
  workspaceAgentGuiProviders
} from "../services/workspaceAgentProviderCatalog.ts";
import {
  createWorkspaceLaunchpadAnalyticsController,
  type WorkspaceLaunchpadAnalyticsController,
  type WorkspaceLaunchpadAnalyticsItemType,
  type WorkspaceLaunchpadOpenTrigger
} from "../services/workspaceLaunchpadAnalytics.ts";
import { resolveWorkspaceDockIconSet } from "../services/workspaceDockIconStyle.ts";
import {
  defaultWorkspaceTerminalWorkbenchTypeId,
  workspaceBrowserNodeID,
  workspaceFilesNodeID
} from "../services/workspaceWorkbenchNodeIds.ts";

type WorkspaceLaunchpadItem = WorkbenchLaunchpadItem<WorkspaceAgentProvider>;
type WorkspaceLaunchpadTranslate = ReturnType<typeof useTranslation>["t"];

export function WorkspaceLaunchpadOverlay({
  dockIconStyle,
  dockPlacement,
  host,
  onClose,
  open,
  openTrigger,
  themeAppearance,
  workspaceId
}: {
  dockIconStyle: DesktopDockIconStyle;
  dockPlacement: WorkbenchDockPlacement;
  host: WorkbenchHostHandle | null;
  onClose: () => void;
  open: boolean;
  openTrigger: WorkspaceLaunchpadOpenTrigger;
  themeAppearance: DesktopThemeAppearance;
  workspaceId: string;
}) {
  const { service: appCenterService, state: appCenterState } =
    useWorkspaceAppCenterService();
  const agentProviderStatusService = useService(IAgentProviderStatusService);
  const { state: workspaceSettingsState } = useWorkspaceSettingsService();
  const reporterService = useService(IReporterService);
  const agentProviderSnapshot = useSyncExternalStore(
    (listener) => agentProviderStatusService.subscribe(listener),
    () => agentProviderStatusService.getSnapshot(),
    () => agentProviderStatusService.getSnapshot()
  );
  const { t } = useTranslation();
  const hiddenAgentProviders = useMemo<
    ReadonlySet<WorkspaceAgentProvider>
  >(() => {
    const hidden: WorkspaceAgentProvider[] = [];
    if (workspaceSettingsState.tuttiAgentSwitchEnabled !== true) {
      hidden.push("tutti-agent");
    }
    return new Set<WorkspaceAgentProvider>(hidden);
  }, [workspaceSettingsState.tuttiAgentSwitchEnabled]);
  const wasOpenRef = useRef(false);
  const launchpadAnalytics = useMemo(
    () =>
      createWorkspaceLaunchpadAnalyticsController({
        reporterService
      }),
    [reporterService]
  );
  const launchpadDockIcons = useMemo(
    () =>
      resolveWorkspaceDockIconSet({
        appearance: themeAppearance,
        style: dockIconStyle
      }),
    [dockIconStyle, themeAppearance]
  );
  const statusByProvider = useMemo(
    () =>
      new Map(
        agentProviderSnapshot.statuses.map((status) => [
          status.provider,
          status
        ])
      ),
    [agentProviderSnapshot.statuses]
  );
  const items = useMemo(
    () =>
      buildWorkbenchLaunchpadItems<WorkspaceAgentProvider>({
        agentDescriptors: resolveLaunchpadAgentDescriptors({
          defaultProvider: agentProviderSnapshot.defaultProvider,
          hiddenProviders: hiddenAgentProviders,
          launchpadDockIcons,
          statusByProvider,
          t
        }),
        apps: appCenterState.apps
          .filter((app) => shouldShowWorkspaceApp(app.appId) && app.installed)
          .map((app) => {
            const launchEnabled =
              app.runtimeStatus === "running" && Boolean(app.launchUrl);
            return {
              appId: app.appId,
              disabledReason: launchEnabled
                ? undefined
                : t("workspace.workbenchDesktop.launchpad.appUnavailable"),
              iconUrl: app.iconUrl,
              label: app.name,
              launchEnabled
            };
          }),
        nodeDescriptors: [
          {
            dockEntryId: workspaceAppCenterNodeID,
            iconUrl: launchpadDockIcons.applications,
            id: workspaceAppCenterNodeID,
            label: t("workspace.workbenchDesktop.nodes.appCenter"),
            typeId: workspaceAppCenterNodeID
          },
          {
            dockEntryId: defaultIssueManagerWorkbenchTypeId,
            iconUrl: launchpadDockIcons.issue,
            id: defaultIssueManagerWorkbenchTypeId,
            label: t("workspace.workbenchDesktop.nodes.issues"),
            typeId: defaultIssueManagerWorkbenchTypeId
          },
          {
            dockEntryId: workspaceFilesNodeID,
            iconUrl: launchpadDockIcons.files,
            id: workspaceFilesNodeID,
            label: t("workspace.workbenchDesktop.nodes.files"),
            typeId: workspaceFilesNodeID
          },
          {
            dockEntryId: workspaceBrowserNodeID,
            iconUrl: launchpadDockIcons.browser,
            id: workspaceBrowserNodeID,
            label: t("workspace.workbenchDesktop.nodes.browser"),
            typeId: workspaceBrowserNodeID
          },
          {
            dockEntryId: defaultWorkspaceTerminalWorkbenchTypeId,
            iconUrl: launchpadDockIcons.terminal,
            id: defaultWorkspaceTerminalWorkbenchTypeId,
            label: t("workspace.workbenchDesktop.nodes.terminal"),
            typeId: defaultWorkspaceTerminalWorkbenchTypeId
          }
        ]
      }),
    [
      agentProviderSnapshot.defaultProvider,
      appCenterState.apps,
      launchpadDockIcons,
      hiddenAgentProviders,
      statusByProvider,
      t
    ]
  );

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) {
      return;
    }
    wasOpenRef.current = true;
    launchpadAnalytics.opened({
      totalItems: items.length,
      trigger: openTrigger
    });
  }, [items.length, launchpadAnalytics, open, openTrigger]);

  const closeLaunchpad = useCallback(() => {
    launchpadAnalytics.closed();
    onClose();
  }, [launchpadAnalytics, onClose]);

  const launchItem = useCallback(
    (item: WorkspaceLaunchpadItem) => {
      if (!item.launchEnabled) {
        return;
      }

      launchpadAnalytics.itemLaunched(resolveLaunchpadAnalyticsItem(item));
      closeLaunchpad();
      if (item.kind === "app") {
        void appCenterService
          .openApp({
            appId: item.appId,
            workspaceId
          })
          .catch(noop);
        return;
      }
      if (item.kind === "node") {
        void host
          ?.launchNode({
            dockEntryId: item.dockEntryId,
            reason: "launchpad",
            typeId: item.typeId
          })
          .catch(noop);
        return;
      }

      void requestWorkspaceAgentGuiLaunch({
        provider: normalizeDesktopAgentGUIProvider(item.provider),
        workspaceId
      }).catch(noop);
    },
    [appCenterService, closeLaunchpad, host, launchpadAnalytics, workspaceId]
  );

  return (
    <SharedWorkbenchLaunchpadOverlay
      copy={{
        clearSearch: t("workspace.workbenchDesktop.launchpad.clearSearch"),
        empty: t("workspace.workbenchDesktop.launchpad.empty"),
        installAction: t("workspace.workbenchDesktop.agentProviders.install"),
        installingAction: t(
          "workspace.workbenchDesktop.agentProviders.installing"
        ),
        label: t("workspace.workbenchDesktop.launchpad.dockLabel"),
        pageDot: ({ page, pageCount }) =>
          t("workspace.workbenchDesktop.launchpad.pageDot", {
            page,
            pageCount
          }),
        pages: t("workspace.workbenchDesktop.launchpad.pages"),
        refreshAction: t("workspace.workbenchDesktop.agentProviders.refresh"),
        searchPlaceholder: t(
          "workspace.workbenchDesktop.launchpad.searchPlaceholder"
        ),
        syncAction: t("workspace.workbenchDesktop.agentProviders.refresh"),
        unavailableItem: ({ reason, title }) =>
          t("workspace.workbenchDesktop.launchpad.unavailableItem", {
            reason,
            title
          })
      }}
      dockPlacement={dockPlacement}
      getAgentActionPending={(agent, actionId) =>
        agentProviderStatusService.isActionPending(agent.provider, actionId)
      }
      getAgentReason={(agent) => agent.reason ?? null}
      items={items}
      open={open}
      onClose={closeLaunchpad}
      onLaunchItem={launchItem}
      onPageChange={({ pageIndex, totalPages }) => {
        launchpadAnalytics.pageChanged({
          pageIndex,
          totalPages
        });
      }}
      onRunAgentAction={(agent, actionId) => {
        closeLaunchpad();
        void agentProviderStatusService
          .runAction(agent.provider, actionId, {
            context: {
              workbenchHost: host ?? undefined,
              workspaceId
            },
            origin: "user"
          })
          .catch(noop);
      }}
      onSearch={({ queryLength, resultCount }) => {
        launchpadAnalytics.searched({
          queryLength,
          resultCount
        });
      }}
    />
  );
}

function resolveLaunchpadAnalyticsItem(
  item: WorkspaceLaunchpadItem
): Parameters<WorkspaceLaunchpadAnalyticsController["itemLaunched"]>[0] {
  if (item.kind === "app") {
    return {
      appId: item.appId,
      fromSearch: false,
      isComingSoon: false,
      itemType: "app",
      provider: null
    };
  }
  if (item.kind === "agent") {
    return {
      appId: null,
      fromSearch: false,
      isComingSoon: item.comingSoon === true,
      itemType: "agent",
      provider: item.provider
    };
  }

  return {
    appId: null,
    fromSearch: false,
    isComingSoon: false,
    itemType: resolveLaunchpadNodeItemType(item.typeId),
    provider: null
  };
}

function resolveLaunchpadAgentDescriptors(input: {
  defaultProvider: WorkspaceAgentProvider | null;
  hiddenProviders: ReadonlySet<WorkspaceAgentProvider>;
  launchpadDockIcons: ReturnType<typeof resolveWorkspaceDockIconSet>;
  statusByProvider: ReadonlyMap<WorkspaceAgentProvider, AgentProviderStatus>;
  t: WorkspaceLaunchpadTranslate;
}): readonly WorkbenchLaunchpadAgentDescriptor<WorkspaceAgentProvider>[] {
  const provider = resolveLaunchpadDefaultAgentProvider({
    defaultProvider: input.defaultProvider,
    hiddenProviders: input.hiddenProviders,
    statusByProvider: input.statusByProvider
  });
  return [
    resolveLaunchpadAgentDescriptor({
      iconUrl: input.launchpadDockIcons.agentUnified,
      id: "agent:unified",
      label: input.t("workspace.workbenchDesktop.nodes.agent"),
      provider,
      statusByProvider: input.statusByProvider,
      t: input.t
    })
  ];
}

function resolveLaunchpadAgentDescriptor(input: {
  iconUrl: string;
  id?: string;
  label: string;
  provider: WorkspaceAgentProvider;
  statusByProvider: ReadonlyMap<WorkspaceAgentProvider, AgentProviderStatus>;
  t: WorkspaceLaunchpadTranslate;
}): WorkbenchLaunchpadAgentDescriptor<WorkspaceAgentProvider> {
  const status = input.statusByProvider.get(input.provider) ?? null;
  const comingSoon =
    isWorkspaceAgentGuiComingSoonProvider(input.provider) ||
    status?.availability.status === "unsupported";
  const launchEnabled = !comingSoon && status?.availability.status === "ready";
  return {
    actions: resolveLaunchpadAgentActions({
      comingSoon,
      status
    }),
    comingSoon,
    disabledReason: launchEnabled
      ? undefined
      : comingSoon
        ? input.t("workspace.workbenchDesktop.agentProviders.comingSoon")
        : input.t("workspace.workbenchDesktop.launchpad.agentUnavailable"),
    iconUrl: input.iconUrl,
    ...(input.id ? { id: input.id } : {}),
    label: input.label,
    launchEnabled,
    provider: input.provider,
    reason: resolveLaunchpadAgentReason(
      {
        comingSoon,
        status
      },
      input.t
    )
  };
}

function resolveLaunchpadDefaultAgentProvider(input: {
  defaultProvider: WorkspaceAgentProvider | null;
  hiddenProviders: ReadonlySet<WorkspaceAgentProvider>;
  statusByProvider: ReadonlyMap<WorkspaceAgentProvider, AgentProviderStatus>;
}): WorkspaceAgentProvider {
  const defaultProvider =
    isLaunchpadAgentProvider(input.defaultProvider) &&
    !input.hiddenProviders.has(input.defaultProvider)
      ? input.defaultProvider
      : null;
  if (
    defaultProvider &&
    input.statusByProvider.get(defaultProvider)?.availability.status === "ready"
  ) {
    return defaultProvider;
  }
  const visibleProviders = workspaceAgentGuiProviders.filter(
    (provider) => !input.hiddenProviders.has(provider)
  );
  const readyProvider = visibleProviders.find(
    (provider) =>
      input.statusByProvider.get(provider)?.availability.status === "ready"
  );
  return (
    readyProvider ??
    defaultProvider ??
    visibleProviders[0] ??
    workspaceAgentGuiProviders[0]
  );
}

function isLaunchpadAgentProvider(
  provider: WorkspaceAgentProvider | null
): provider is WorkspaceAgentProvider {
  return (
    provider !== null &&
    workspaceAgentGuiProviders.includes(
      provider as (typeof workspaceAgentGuiProviders)[number]
    )
  );
}

function resolveLaunchpadNodeItemType(
  typeId: string
): WorkspaceLaunchpadAnalyticsItemType {
  switch (typeId) {
    case workspaceAppCenterNodeID:
      return "app_center";
    case workspaceBrowserNodeID:
      return "browser";
    case workspaceFilesNodeID:
      return "files";
    case defaultWorkspaceTerminalWorkbenchTypeId:
      return "terminal";
    case defaultIssueManagerWorkbenchTypeId:
      return "issue_manager";
    default:
      return "app";
  }
}

function resolveLaunchpadAgentActions(input: {
  comingSoon: boolean;
  status: AgentProviderStatus | null;
}): { id: string }[] {
  if (input.comingSoon) {
    return [];
  }
  if (input.status === null) {
    return [{ id: "refresh" }];
  }
  switch (input.status.availability.status) {
    case "not_installed":
      return input.status.actions.filter((action) => action.id === "install");
    case "auth_required":
      return input.status.actions.filter((action) => action.id === "login");
    case "ready":
      return [];
    default:
      return input.status.actions.length
        ? input.status.actions
        : [{ id: "refresh" }];
  }
}

function resolveLaunchpadAgentReason(
  input: {
    comingSoon: boolean;
    status: AgentProviderStatus | null;
  },
  t: WorkspaceLaunchpadTranslate
): string | null {
  if (input.comingSoon) {
    return t("workspace.workbenchDesktop.agentProviders.comingSoon");
  }
  if (input.status === null) {
    return t("workspace.workbenchDesktop.agentProviders.unknown");
  }
  switch (input.status.availability.status) {
    case "not_installed":
      return t("workspace.workbenchDesktop.agentProviders.installRequired");
    case "auth_required":
      return t("workspace.workbenchDesktop.agentProviders.loginRequired");
    case "ready":
      return null;
    default:
      return t("workspace.workbenchDesktop.agentProviders.unknown");
  }
}

function noop(): void {}
