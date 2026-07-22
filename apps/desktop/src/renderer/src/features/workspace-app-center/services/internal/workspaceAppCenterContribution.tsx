import { createElement, useEffect, useRef, type ReactNode } from "react";
import {
  type BrowserNodeNavigationPolicy,
  type BrowserNodeFeature
} from "@tutti-os/browser-node";
import { BrowserNode } from "@tutti-os/browser-node/react";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  AddIcon,
  Button,
  CloseIcon,
  NavApplicationsLinedIcon,
  Spinner,
  cn
} from "@tutti-os/ui-system";
import { resolveWorkspaceAppStatusPresentation } from "@tutti-os/workspace-app-center/core";
import { createAppCenterI18nRuntime } from "@tutti-os/workspace-app-center/i18n";
import type {
  WorkbenchContribution,
  WorkbenchHostDockEntry,
  WorkbenchHostNodeBodyContext,
  WorkbenchHostNodeHeaderContext,
  WorkbenchHostNodeDefinition
} from "@tutti-os/workbench-surface";
import { createWorkspaceWorkbenchDesktopI18nRuntime } from "@shared/i18n";
import { WorkspaceWorkbenchTrafficLights } from "@renderer/features/workspace-workbench/ui/WorkspaceWorkbenchTrafficLights";
import type { IReporterService } from "@renderer/features/analytics";
import type { IWorkspaceAppCenterService } from "../workspaceAppCenterService.interface";
import {
  closeWorkspaceAppTab,
  readWorkspaceAppTabIds,
  selectWorkspaceAppTab
} from "../workspaceAppCenterTabs.ts";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterViewState
} from "@tutti-os/workspace-app-center";
import { createWorkspaceAppCenterOpenedLease } from "./workspaceAppCenterAnalytics.ts";
import { createWorkspaceAppWebviewExternalStateSource } from "./workspaceAppCenterExternalState.ts";
import {
  WorkspaceAppCenterInlineAppBody,
  workspaceAppBrowserPartitionPrefix
} from "./workspaceAppCenterInlineAppBody.tsx";
import {
  workspaceAppCenterDockOrder,
  workspaceAppDockOrderStart
} from "./workspaceAppCenterDockOrdering.ts";
import { projectWorkspaceAppCenterDockApps } from "./workspaceAppCenterDockProjection.ts";
import { workspaceAppCenterFrame } from "./workspaceAppCenterFrame.ts";
import {
  readWorkspaceAppOpenPayload,
  resolveWorkspaceAppWebviewUrl,
  type WorkspaceAppWebviewExternalState
} from "./workspaceAppCenterWebviewUrl.ts";
import { workspaceAppWebviewFrame } from "./workspaceAppWebviewFrame.ts";
import {
  shouldPreserveWorkspaceAppWebviewDuringHandoff,
  shouldRenderWorkspaceAppBrowserNode,
  shouldSyncWorkspaceAppWebviewDefaultUrl
} from "./workspaceAppCenterWebviewHandoff.ts";
import {
  findWorkspaceApp,
  readWorkspaceAppIdFromInstanceId,
  resolveWorkspaceAppCenterLaunchRequest,
  resolveWorkspaceAppDisplayName,
  workspaceAppCenterNodeID,
  workspaceAppDockEntryId,
  workspaceAppWebviewTypeID
} from "./workspaceAppCenterLaunchRequest.ts";
import { shouldShowWorkspaceApp } from "../workspaceAppVisibility.ts";
import { useSnapshot } from "valtio";

export { workspaceAppBrowserPartitionPrefix } from "./workspaceAppCenterInlineAppBody.tsx";

const defaultWorkspaceAppCenterViewState: WorkspaceAppCenterViewState = {
  activeAppTab: "recommended"
};

export {
  readWorkspaceAppIdFromDockEntryId,
  readWorkspaceAppIdFromInstanceId,
  readWorkspaceAppIdFromNodeId,
  reportWorkspaceAppOpenedFromDockEntry,
  resolveWorkspaceAppDisplayName,
  workspaceAppCenterNodeID,
  workspaceAppDockEntryId,
  workspaceAppWebviewInstanceId,
  workspaceAppWebviewTypeID
} from "./workspaceAppCenterLaunchRequest.ts";

const workspaceDockApplicationsIconUrl = new URL(
  "../../../../assets/workspace-canvas/dock/workspace-dock-applications.png",
  import.meta.url
).href;

export interface CreateWorkspaceAppCenterContributionInput {
  appCenterService: IWorkspaceAppCenterService;
  browserFeature: BrowserNodeFeature;
  i18n: I18nRuntime<string>;
  reporterService?: Pick<IReporterService, "trackEvents">;
  workspaceId: string;
}

export function createWorkspaceAppCenterContribution({
  appCenterService,
  browserFeature,
  i18n,
  reporterService,
  workspaceId
}: CreateWorkspaceAppCenterContributionInput): WorkbenchContribution {
  return {
    externalStateSource: createWorkspaceAppWebviewExternalStateSource({
      appCenterService,
      runtimeStore: browserFeature.runtimeStore
    }),
    id: "workspace-app-center",
    nodes: [
      createAppCenterNodeDefinition({
        appCenterService,
        browserFeature,
        i18n,
        reporterService,
        workspaceId
      }),
      createWorkspaceAppWebviewNodeDefinition({
        appCenterService,
        browserFeature,
        i18n,
        reporterService,
        workspaceId
      })
    ],
    onLaunchRequest: async (request) =>
      resolveWorkspaceAppCenterLaunchRequest({
        appCenterService,
        reporterService,
        request
      })
  };
}

export function createWorkspaceAppCenterDockEntries(input: {
  appCenterIconUrl?: string;
  appCenterService: IWorkspaceAppCenterService;
  captureWebviewPreview?: (
    nodeId: string
  ) => Promise<string | null> | string | null;
  i18n: I18nRuntime<string>;
}): WorkbenchHostDockEntry[] {
  return [
    createAppCenterDockEntry(input.i18n, input.appCenterIconUrl),
    ...projectWorkspaceAppCenterDockApps(input.appCenterService.store.apps)
      .filter((projection) => shouldShowWorkspaceApp(projection.app.appId))
      .map((projection, index) =>
        createWorkspaceAppDockEntry({
          app: projection.app,
          captureWebviewPreview: input.captureWebviewPreview,
          clickBehavior: projection.clickBehavior,
          index,
          launchEnabled: projection.launchEnabled,
          state: projection.state
        })
      )
  ];
}

function createAppCenterDockEntry(
  i18n: I18nRuntime<string>,
  iconUrl = workspaceDockApplicationsIconUrl
): WorkbenchHostDockEntry {
  const title = i18n.t("workspace.appCenter.dockLabel");
  return {
    icon: createElement("img", {
      alt: "",
      "aria-hidden": "true",
      draggable: false,
      src: iconUrl
    }),
    id: workspaceAppCenterNodeID,
    label: title,
    launchBehavior: "enabled",
    matchNode: (node) => node.data.typeId === workspaceAppCenterNodeID,
    order: workspaceAppCenterDockOrder,
    resolvePopupItem: ({ node }) => ({
      revision: node.title,
      title: node.title || title
    }),
    sectionId: "apps",
    typeId: workspaceAppCenterNodeID,
    visibility: "always"
  };
}

function createWorkspaceAppDockEntry(input: {
  app: WorkspaceAppCenterApp;
  captureWebviewPreview?: (
    nodeId: string
  ) => Promise<string | null> | string | null;
  clickBehavior?: WorkbenchHostDockEntry["clickBehavior"];
  index: number;
  launchEnabled: boolean;
  state?: WorkbenchHostDockEntry["state"];
}): WorkbenchHostDockEntry {
  const dockEntryId = workspaceAppDockEntryId(input.app.appId);
  const appTitle = resolveWorkspaceAppDisplayName(input.app);
  return {
    ...(input.captureWebviewPreview
      ? {
          capturePopupItemPreview: ({ node }) =>
            input.captureWebviewPreview?.(node.id) ?? null
        }
      : {}),
    ...(input.clickBehavior ? { clickBehavior: input.clickBehavior } : {}),
    icon: createWorkspaceAppDockIcon(input.app),
    id: dockEntryId,
    instanceMode: "single",
    label: appTitle,
    launchBehavior: input.launchEnabled ? "enabled" : "disabled",
    launchPayload: {
      appId: input.app.appId
    },
    matchNode: (node) =>
      node.data.typeId === workspaceAppWebviewTypeID &&
      readWorkspaceAppIdFromInstanceId(node.data.instanceId) ===
        input.app.appId,
    order: workspaceAppDockOrderStart + input.index,
    resolvePopupItem: ({ node }) => {
      const title = node.title || appTitle;
      const subtitle = input.app.launchUrl ?? node.data.instanceId;
      return {
        revision: `${title}\n${subtitle}`,
        subtitle,
        title
      };
    },
    sectionId: "apps",
    state: input.state,
    typeId: workspaceAppWebviewTypeID,
    visibility: "always"
  };
}

function createWorkspaceAppDockIcon(app: WorkspaceAppCenterApp): ReactNode {
  const iconUrl = app.iconUrl;
  if (iconUrl) {
    return createElement(
      "span",
      {
        "aria-hidden": "true",
        "data-workspace-app-icon": "true"
      },
      createElement("img", {
        alt: "",
        draggable: false,
        src: iconUrl
      })
    );
  }
  return <NavApplicationsLinedIcon aria-hidden className="size-7" />;
}

function createAppCenterNodeDefinition(input: {
  appCenterService: IWorkspaceAppCenterService;
  browserFeature: BrowserNodeFeature;
  i18n: I18nRuntime<string>;
  reporterService?: Pick<IReporterService, "trackEvents">;
  workspaceId: string;
}): WorkbenchHostNodeDefinition<WorkspaceAppCenterViewState | null> {
  return {
    createLease: () =>
      createWorkspaceAppCenterOpenedLease({
        reporterService: input.reporterService
      }),
    frame: workspaceAppCenterFrame,
    renderBody: (context) => (
      <WorkspaceAppCenterInlineAppBody
        appCenterService={input.appCenterService}
        browserFeature={input.browserFeature}
        context={context}
        fallbackLabel={input.i18n.t("common.loading")}
        i18n={input.i18n}
        workspaceId={input.workspaceId}
      />
    ),
    renderHeader: (context) => (
      <WorkspaceAppCenterWorkbenchHeader
        appCenterService={input.appCenterService}
        context={context}
        i18n={input.i18n}
        workspaceId={input.workspaceId}
      />
    ),
    title: input.i18n.t("workspace.workbenchDesktop.nodes.appCenter"),
    typeId: workspaceAppCenterNodeID,
    window: {
      closable: true,
      defaultOpen: false,
      minimizedDock: {
        kind: "snapshot"
      },
      minimizable: true,
      restoreOnLoad: true
    }
  };
}

function WorkspaceAppCenterWorkbenchHeader({
  appCenterService,
  context,
  i18n,
  workspaceId
}: {
  appCenterService: IWorkspaceAppCenterService;
  context: WorkbenchHostNodeHeaderContext<WorkspaceAppCenterViewState | null>;
  i18n: I18nRuntime<string>;
  workspaceId: string;
}): ReactNode {
  const appCenterI18n = createWorkspaceWorkbenchDesktopI18nRuntime(i18n);
  const state = useSnapshot(appCenterService.store);
  const viewState =
    state.viewStateByWorkspaceId[workspaceId] ??
    context.externalNodeState ??
    defaultWorkspaceAppCenterViewState;
  const openAppId = viewState.openAppId?.trim() ?? "";
  const openApps = readWorkspaceAppTabIds(
    viewState as WorkspaceAppCenterViewState
  )
    .map((appId) => findWorkspaceApp(appCenterService, appId))
    .filter((app): app is WorkspaceAppCenterApp => app !== null);
  const {
    onDoubleClick: onDragDoubleClick,
    onPointerDown: onDragPointerDown,
    ...restDragHandleProps
  } = context.dragHandleProps;

  const updateSelectedTab = (appId: string | null): void => {
    appCenterService.setViewState({
      state: selectWorkspaceAppTab(
        appCenterService.getViewState(workspaceId, context.externalNodeState),
        appId
      ),
      workspaceId
    });
  };

  const closeAppTab = (appId: string): void => {
    appCenterService.setViewState({
      state: closeWorkspaceAppTab(
        appCenterService.getViewState(workspaceId, context.externalNodeState),
        appId
      ),
      workspaceId
    });
  };

  return (
    <div
      {...restDragHandleProps}
      className="flex h-full min-h-0 items-center gap-1.5 bg-[var(--background-panel)] px-2 pl-4 cursor-grab active:cursor-grabbing"
      data-workspace-app-center-tab-strip="true"
      onPointerDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(".nodrag")
        ) {
          return;
        }
        onDragPointerDown?.(event);
      }}
      onDoubleClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(".nodrag")
        ) {
          return;
        }
        event.stopPropagation();
        onDragDoubleClick?.(event);
      }}
    >
      <WorkspaceWorkbenchTrafficLights
        className="nodrag"
        displayMode={context.displayMode}
        i18n={appCenterI18n}
        windowActions={context.windowActions}
      />
      {openApps.length > 0 ? (
        <>
          <div
            aria-label={i18n.t("workspace.appCenter.tabs.label")}
            className="nodrag flex min-w-0 max-w-[70%] items-center gap-1 overflow-x-auto"
            role="tablist"
          >
            <WorkspaceAppCenterTab
              active={!openAppId}
              icon={
                <NavApplicationsLinedIcon aria-hidden className="size-3.5" />
              }
              tabId="catalog"
              title={context.node.title}
              onSelect={() => updateSelectedTab(null)}
            />
            {openApps.map((app) => (
              <WorkspaceAppCenterTab
                active={openAppId === app.appId}
                closeLabel={i18n.t("workspace.appCenter.tabs.close")}
                icon={<WorkspaceAppCenterTabIcon app={app} />}
                key={app.appId}
                tabId={app.appId}
                title={resolveWorkspaceAppDisplayName(app)}
                onClose={() => closeAppTab(app.appId)}
                onSelect={() => updateSelectedTab(app.appId)}
              />
            ))}
          </div>
          <Button
            aria-label={i18n.t("workspace.appCenter.tabs.new")}
            className="nodrag shrink-0 rounded-md"
            size="icon-sm"
            title={i18n.t("workspace.appCenter.tabs.new")}
            type="button"
            variant="chrome"
            onClick={() => updateSelectedTab(null)}
          >
            <AddIcon className="size-4" />
          </Button>
        </>
      ) : (
        <div className="min-w-0 truncate text-[13px] font-semibold text-[var(--text-primary)]">
          {context.node.title}
        </div>
      )}
      <div className="min-w-8 flex-1 self-stretch" aria-hidden="true" />
    </div>
  );
}

function WorkspaceAppCenterTab({
  active,
  closeLabel,
  icon,
  onClose,
  onSelect,
  tabId,
  title
}: {
  active: boolean;
  closeLabel?: string;
  icon: ReactNode;
  onClose?: () => void;
  onSelect: () => void;
  tabId: string;
  title: string;
}): ReactNode {
  return (
    <div
      className={cn(
        "group flex h-7 min-w-[104px] max-w-[220px] items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
        active
          ? "border-[var(--line-2)] bg-[var(--background-fronted)] text-[var(--text-primary)] shadow-sm"
          : "border-transparent text-[var(--text-secondary)] hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)]"
      )}
      data-workspace-app-center-tab={tabId}
      data-workspace-app-center-tab-active={active ? "true" : "false"}
    >
      <button
        aria-selected={active}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        role="tab"
        title={title}
        type="button"
        onClick={onSelect}
      >
        <span className="shrink-0 text-[var(--text-tertiary)]">{icon}</span>
        <span className="truncate">{title}</span>
      </button>
      {onClose && closeLabel ? (
        <button
          aria-label={closeLabel}
          className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)]"
          title={closeLabel}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <CloseIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

function WorkspaceAppCenterTabIcon({
  app
}: {
  app: WorkspaceAppCenterApp;
}): ReactNode {
  return app.iconUrl ? (
    <img
      alt=""
      aria-hidden="true"
      className="size-3.5 rounded-[3px] object-cover"
      draggable={false}
      src={app.iconUrl}
    />
  ) : (
    <NavApplicationsLinedIcon aria-hidden className="size-3.5" />
  );
}

function createWorkspaceAppWebviewNodeDefinition(input: {
  appCenterService: IWorkspaceAppCenterService;
  browserFeature: BrowserNodeFeature;
  i18n: I18nRuntime<string>;
  reporterService?: Pick<IReporterService, "trackEvents">;
  workspaceId: string;
}): WorkbenchHostNodeDefinition<WorkspaceAppWebviewExternalState | null> {
  const appCenterCopy = createAppCenterI18nRuntime(input.i18n);
  return {
    frame: workspaceAppWebviewFrame,
    instance: {
      mode: "multi"
    },
    renderBody: (context) => (
      <WorkspaceAppWebviewBody
        appCenterCopy={appCenterCopy}
        appCenterService={input.appCenterService}
        browserFeature={input.browserFeature}
        context={context}
        fallbackLabel={input.i18n.t("common.loading")}
        workspaceId={input.workspaceId}
      />
    ),
    renderHeader: (context) => (
      <WorkspaceAppWebviewHeader context={context} i18n={input.i18n} />
    ),
    title: input.i18n.t("workspace.workbenchDesktop.nodes.appWebview"),
    typeId: workspaceAppWebviewTypeID,
    window: {
      closable: true,
      defaultOpen: false,
      keepMountedWhenMinimized: (node) =>
        shouldKeepWorkspaceAppWebviewMountedWhenMinimized({
          appCenterService: input.appCenterService,
          instanceId: node.data.instanceId
        }),
      minimizedDock: {
        capturePreview: ({ node }) =>
          input.browserFeature.hostApi.capturePreview?.({ nodeId: node.id }) ??
          null,
        kind: "snapshot"
      },
      minimizable: true,
      restoreOnLoad: true
    }
  };
}

function WorkspaceAppWebviewHeader({
  context,
  i18n
}: {
  context: WorkbenchHostNodeHeaderContext<unknown>;
  i18n: I18nRuntime<string>;
}): ReactNode {
  const appCenterI18n = createWorkspaceWorkbenchDesktopI18nRuntime(i18n);

  return (
    <div className="flex h-full min-h-0 items-center gap-3 bg-[var(--background-panel)] px-3 pl-4">
      <WorkspaceWorkbenchTrafficLights
        className="nodrag"
        displayMode={context.displayMode}
        i18n={appCenterI18n}
        windowActions={context.windowActions}
      />
      <div
        {...context.dragHandleProps}
        className="flex h-full min-w-0 flex-1 cursor-grab items-center gap-2 active:cursor-grabbing"
      >
        <div className="min-w-0 truncate text-[13px] font-semibold text-[var(--text-primary)]">
          {context.node.title}
        </div>
      </div>
    </div>
  );
}

function WorkspaceAppWebviewBody({
  appCenterCopy,
  appCenterService,
  browserFeature,
  context,
  fallbackLabel,
  workspaceId
}: {
  appCenterCopy: ReturnType<typeof createAppCenterI18nRuntime>;
  appCenterService: IWorkspaceAppCenterService;
  browserFeature: BrowserNodeFeature;
  context: WorkbenchHostNodeBodyContext<
    WorkspaceAppWebviewExternalState | null,
    unknown
  >;
  fallbackLabel: string;
  workspaceId: string;
}): ReactNode {
  const recentHandoffAppIdRef = useRef<string | null>(null);
  const appId =
    readWorkspaceAppIdFromInstanceId(context.node.data.instanceId) ??
    readWorkspaceAppOpenPayload(context.activation)?.appId ??
    "unknown";
  const app = findWorkspaceApp(appCenterService, appId);
  const externalNodeUrl = context.externalNodeState?.url ?? null;
  const handoffOptions = {
    externalNodeUrl,
    hadRecentHandoff: recentHandoffAppIdRef.current === appId
  };
  const hasDirectHandoffState =
    shouldPreserveWorkspaceAppWebviewDuringHandoff(app);
  const preserveWebviewDuringHandoff =
    shouldPreserveWorkspaceAppWebviewDuringHandoff(app, handoffOptions);
  const shouldSyncDefaultUrl = shouldSyncWorkspaceAppWebviewDefaultUrl(
    app,
    handoffOptions
  );
  const defaultUrl = resolveWorkspaceAppWebviewUrl({
    activation: context.activation,
    appCanUseExternalState: app
      ? app.runtimeStatus === "running" || preserveWebviewDuringHandoff
      : false,
    appLaunchUrl: app?.launchUrl ?? null,
    externalNodeState: context.externalNodeState,
    preferExternalState: preserveWebviewDuringHandoff && !shouldSyncDefaultUrl
  });
  const shouldRenderBrowserNode = shouldRenderWorkspaceAppBrowserNode(
    app,
    defaultUrl,
    handoffOptions
  );
  const navigationPolicy = resolveWorkspaceAppWebviewNavigationPolicy({
    appCenterService,
    appId,
    fallbackUrl: defaultUrl
  });

  useEffect(() => {
    if (hasDirectHandoffState) {
      recentHandoffAppIdRef.current = appId;
      return;
    }
    if (app?.runtimeStatus === "running" && app.installProgress == null) {
      recentHandoffAppIdRef.current = null;
      return;
    }
    if (app?.runtimeStatus === "idle" || app?.runtimeStatus === "failed") {
      recentHandoffAppIdRef.current = null;
      return;
    }
    if (!app || recentHandoffAppIdRef.current !== appId) {
      recentHandoffAppIdRef.current = null;
    }
  }, [app, appId, hasDirectHandoffState]);

  if (!shouldRenderBrowserNode) {
    return (
      <WorkspaceAppWebviewLoadingState
        app={app}
        copy={appCenterCopy}
        fallbackLabel={fallbackLabel}
      />
    );
  }
  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden bg-[var(--background-panel)]">
      <BrowserNode
        defaultUrl={defaultUrl}
        feature={browserFeature}
        hidden={context.node.isMinimized}
        navigationPolicy={navigationPolicy}
        nodeId={context.node.id}
        onFocusRequest={context.isFocused ? undefined : () => context.focus()}
        sessionPartition={workspaceAppBrowserSessionPartition({
          appId,
          workspaceId
        })}
        showHeader={false}
        syncDefaultUrl={shouldSyncDefaultUrl}
      />
      {preserveWebviewDuringHandoff ? (
        <div className="pointer-events-auto absolute inset-0 z-20">
          <WorkspaceAppWebviewLoadingState
            app={app}
            copy={appCenterCopy}
            fallbackLabel={fallbackLabel}
          />
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceAppWebviewLoadingState({
  app,
  copy,
  fallbackLabel
}: {
  app: WorkspaceAppCenterApp | null;
  copy: ReturnType<typeof createAppCenterI18nRuntime>;
  fallbackLabel: string;
}): ReactNode {
  const isFailed = app?.runtimeStatus === "failed";
  const failedStatusLabel = app
    ? copy.t(resolveWorkspaceAppStatusPresentation(app.runtimeStatus).labelKey)
    : fallbackLabel;
  const statusLabel = isFailed ? failedStatusLabel : fallbackLabel;

  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center bg-[var(--background-panel)] p-6 text-[var(--text-primary)]">
      <div
        aria-live="polite"
        className="flex min-w-0 items-center gap-2 bg-transparent p-0 text-[13px] leading-5 text-[var(--text-secondary)]"
        role="status"
      >
        {!isFailed ? (
          <Spinner className="text-[var(--text-secondary)]" />
        ) : null}
        <span className="min-w-0 truncate">{statusLabel}</span>
      </div>
    </div>
  );
}

function resolveWorkspaceAppWebviewNavigationPolicy(input: {
  appCenterService: IWorkspaceAppCenterService;
  appId: string;
  fallbackUrl: string;
}): BrowserNodeNavigationPolicy | null {
  const appUrl =
    input.appCenterService.store.apps.find(
      (candidate) => candidate.appId === input.appId
    )?.launchUrl ?? input.fallbackUrl;
  const trimmedUrl = appUrl.trim();
  if (!trimmedUrl || trimmedUrl === "about:blank") {
    return null;
  }

  return {
    mode: "same-origin",
    originUrl: trimmedUrl
  };
}

function shouldKeepWorkspaceAppWebviewMountedWhenMinimized(input: {
  appCenterService: IWorkspaceAppCenterService;
  instanceId: string;
}): boolean {
  const appId = readWorkspaceAppIdFromInstanceId(input.instanceId);
  const app = appId ? findWorkspaceApp(input.appCenterService, appId) : null;
  return app?.minimizeBehavior !== "hibernate";
}

function workspaceAppBrowserSessionPartition(input: {
  appId: string;
  workspaceId: string;
}): string {
  return `${workspaceAppBrowserPartitionPrefix}${encodeURIComponent(
    input.workspaceId
  )}:${encodeURIComponent(input.appId)}`;
}
