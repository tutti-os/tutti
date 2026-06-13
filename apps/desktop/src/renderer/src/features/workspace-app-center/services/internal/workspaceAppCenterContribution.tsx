import { createElement, type ReactNode } from "react";
import {
  type BrowserNodeNavigationPolicy,
  type BrowserNodeRuntimeState,
  type BrowserNodeFeature
} from "@tutti-os/browser-node";
import { BrowserNode } from "@tutti-os/browser-node/react";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { NavApplicationsLinedIcon, Spinner } from "@tutti-os/ui-system";
import { resolveWorkspaceAppStatusPresentation } from "@tutti-os/workspace-app-center/core";
import { createAppCenterI18nRuntime } from "@tutti-os/workspace-app-center/i18n";
import type {
  WorkbenchContribution,
  WorkbenchHostActivation,
  WorkbenchHostDockEntry,
  WorkbenchHostExternalStateLookupInput,
  WorkbenchHostExternalStateSource,
  WorkbenchHostNodeDefinition
} from "@tutti-os/workbench-surface";
import { WorkspaceAppCenterPane } from "../../ui/WorkspaceAppCenterPane.tsx";
import type { IReporterService } from "@renderer/features/analytics";
import type { IWorkspaceAppCenterService } from "../workspaceAppCenterService.interface";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterViewState
} from "../workspaceAppCenterTypes";
import { createWorkspaceAppCenterOpenedLease } from "./workspaceAppCenterAnalytics.ts";
import {
  workspaceAppCenterDockOrder,
  workspaceAppDockOrderStart
} from "./workspaceAppCenterDockOrdering.ts";
import { projectWorkspaceAppCenterDockApps } from "./workspaceAppCenterDockProjection.ts";
import { workspaceAppCenterFrame } from "./workspaceAppCenterFrame.ts";
import { workspaceAppWebviewFrame } from "./workspaceAppWebviewFrame.ts";
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

export const workspaceAppBrowserPartitionPrefix = "persist:tutti-app:";

export {
  reportWorkspaceAppOpenedFromDockEntry,
  resolveWorkspaceAppDisplayName,
  resolveWorkspaceAppSizeConstraints,
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
  resolveAppIconUrl?: (appId: string) => string | null;
  workspaceId: string;
}

export function createWorkspaceAppCenterContribution({
  appCenterService,
  browserFeature,
  i18n,
  reporterService,
  resolveAppIconUrl,
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
        i18n,
        reporterService,
        resolveAppIconUrl,
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
  resolveAppIconUrl?: (appId: string) => string | null;
}): WorkbenchHostDockEntry[] {
  return [
    createAppCenterDockEntry(input.i18n, input.appCenterIconUrl),
    ...projectWorkspaceAppCenterDockApps(input.appCenterService.store.apps)
      .filter((projection) => shouldShowWorkspaceApp(projection.app.appId))
      .map((projection, index) =>
        createWorkspaceAppDockEntry({
          app: projection.app,
          captureWebviewPreview: input.captureWebviewPreview,
          index,
          launchEnabled: projection.launchEnabled,
          overrideIconUrl: input.resolveAppIconUrl?.(projection.app.appId),
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
  index: number;
  launchEnabled: boolean;
  overrideIconUrl?: string | null;
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
    icon: createWorkspaceAppDockIcon(input.app, input.overrideIconUrl),
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
      const subtitle = input.app.url ?? node.data.instanceId;
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

function createWorkspaceAppDockIcon(
  app: WorkspaceAppCenterApp,
  overrideIconUrl?: string | null
): ReactNode {
  const iconUrl = overrideIconUrl ?? app.iconUrl;
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
  i18n: I18nRuntime<string>;
  reporterService?: Pick<IReporterService, "trackEvents">;
  resolveAppIconUrl?: (appId: string) => string | null;
  workspaceId: string;
}): WorkbenchHostNodeDefinition<WorkspaceAppCenterViewState | null> {
  return {
    createLease: () =>
      createWorkspaceAppCenterOpenedLease({
        reporterService: input.reporterService
      }),
    frame: workspaceAppCenterFrame,
    renderBody: (context) => (
      <WorkspaceAppCenterPane
        restoredViewState={context.externalNodeState}
        resolveAppIconUrl={input.resolveAppIconUrl}
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
    renderBody: (context) => {
      const appId =
        readWorkspaceAppIdFromInstanceId(context.node.data.instanceId) ??
        readWorkspaceAppOpenPayload(context.activation)?.appId ??
        "unknown";
      const app = findWorkspaceApp(input.appCenterService, appId);
      const defaultUrl = resolveWorkspaceAppWebviewUrl({
        activation: context.activation,
        appCanUseExternalState: app ? app.runtimeStatus === "running" : false,
        appUrl: app?.url ?? null,
        externalNodeState: context.externalNodeState
      });
      const navigationPolicy = resolveWorkspaceAppWebviewNavigationPolicy({
        appCenterService: input.appCenterService,
        appId,
        fallbackUrl: defaultUrl
      });
      if (!isWorkspaceAppWebviewReady(app, defaultUrl)) {
        return (
          <WorkspaceAppWebviewLoadingState
            app={app}
            copy={appCenterCopy}
            fallbackLabel={input.i18n.t("common.loading")}
          />
        );
      }
      return (
        <BrowserNode
          defaultUrl={defaultUrl}
          feature={input.browserFeature}
          navigationPolicy={navigationPolicy}
          nodeId={context.node.id}
          onFocusRequest={context.isFocused ? undefined : () => context.focus()}
          sessionPartition={workspaceAppBrowserSessionPartition({
            appId,
            workspaceId: input.workspaceId
          })}
          showHeader={false}
          syncDefaultUrl={true}
        />
      );
    },
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

interface WorkspaceAppWebviewExternalState {
  title: string | null;
  url: string | null;
}

type WorkspaceAppCenterExternalNodeState =
  | WorkspaceAppCenterViewState
  | WorkspaceAppWebviewExternalState
  | null;

function createWorkspaceAppWebviewExternalStateSource(input: {
  appCenterService: IWorkspaceAppCenterService;
  runtimeStore: {
    getSnapshot(): Record<string, BrowserNodeRuntimeState | undefined>;
    subscribe(listener: () => void): () => void;
  };
}): WorkbenchHostExternalStateSource<
  WorkspaceAppCenterExternalNodeState,
  null
> {
  return {
    getNodeState(request) {
      if (request.typeId === workspaceAppCenterNodeID) {
        return input.appCenterService.getViewState(request.workspaceId);
      }
      return readWorkspaceAppExternalState(input, request);
    },
    getSnapshotNodeState(request) {
      if (request.typeId === workspaceAppCenterNodeID) {
        return input.appCenterService.getViewState(request.workspaceId);
      }
      return readWorkspaceAppExternalState(input, request);
    },
    getWorkspaceState() {
      return null;
    },
    subscribe(listener) {
      const unsubscribeRuntime = input.runtimeStore.subscribe(listener);
      const unsubscribeAppCenter = input.appCenterService.subscribe(listener);
      return () => {
        unsubscribeRuntime();
        unsubscribeAppCenter();
      };
    }
  };
}

function readWorkspaceAppExternalState(
  input: {
    appCenterService: IWorkspaceAppCenterService;
    runtimeStore: {
      getSnapshot(): Record<string, BrowserNodeRuntimeState | undefined>;
    };
  },
  request: WorkbenchHostExternalStateLookupInput
): WorkspaceAppWebviewExternalState | null {
  if (request.typeId !== workspaceAppWebviewTypeID) {
    return null;
  }
  const runtime = input.runtimeStore.getSnapshot()[request.nodeId];
  const runtimeUrl = runtime?.url?.trim();
  if (runtimeUrl) {
    return {
      title: runtime?.title?.trim() || null,
      url: runtimeUrl
    };
  }

  const appId =
    readWorkspaceAppIdFromNodeId(request.nodeId) ??
    readWorkspaceAppIdFromInstanceId(request.instanceId);
  const app = appId ? findWorkspaceApp(input.appCenterService, appId) : null;
  return app?.url
    ? {
        title: resolveWorkspaceAppDisplayName(app),
        url: app.url
      }
    : null;
}

function resolveWorkspaceAppWebviewUrl(input: {
  activation: WorkbenchHostActivation | null;
  appCanUseExternalState: boolean;
  appUrl: string | null;
  externalNodeState: WorkspaceAppWebviewExternalState | null;
}): string {
  return (
    readWorkspaceAppOpenPayload(input.activation)?.url ??
    normalizeWorkspaceAppUrl(input.appUrl) ??
    (input.appCanUseExternalState ? input.externalNodeState?.url : null) ??
    "about:blank"
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
    )?.url ?? input.fallbackUrl;
  const trimmedUrl = appUrl.trim();
  if (!trimmedUrl || trimmedUrl === "about:blank") {
    return null;
  }

  return {
    mode: "same-origin",
    originUrl: trimmedUrl
  };
}

function isWorkspaceAppWebviewReady(
  app: WorkspaceAppCenterApp | null,
  defaultUrl: string
): boolean {
  const url = normalizeWorkspaceAppUrl(defaultUrl);
  return (
    app?.runtimeStatus === "running" && url !== null && url !== "about:blank"
  );
}

function shouldKeepWorkspaceAppWebviewMountedWhenMinimized(input: {
  appCenterService: IWorkspaceAppCenterService;
  instanceId: string;
}): boolean {
  const appId = readWorkspaceAppIdFromInstanceId(input.instanceId);
  const app = appId ? findWorkspaceApp(input.appCenterService, appId) : null;
  return app?.minimizeBehavior !== "hibernate";
}

function normalizeWorkspaceAppUrl(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function readWorkspaceAppOpenPayload(
  activation: WorkbenchHostActivation | null
): { appId: string; title?: string; url: string } | null {
  if (
    activation?.type !== "open-url" ||
    !activation.payload ||
    typeof activation.payload !== "object"
  ) {
    return null;
  }
  const payload = activation.payload as {
    appId?: unknown;
    title?: unknown;
    url?: unknown;
  };
  return typeof payload.appId === "string" && typeof payload.url === "string"
    ? {
        appId: payload.appId,
        title: typeof payload.title === "string" ? payload.title : undefined,
        url: payload.url
      }
    : null;
}

function workspaceAppBrowserSessionPartition(input: {
  appId: string;
  workspaceId: string;
}): string {
  return `${workspaceAppBrowserPartitionPrefix}${encodeURIComponent(
    input.workspaceId
  )}:${encodeURIComponent(input.appId)}`;
}

function readWorkspaceAppIdFromNodeId(value: string): string | null {
  const prefix = `${workspaceAppWebviewTypeID}:`;
  return value.startsWith(prefix)
    ? readWorkspaceAppIdFromInstanceId(value.slice(prefix.length))
    : null;
}
