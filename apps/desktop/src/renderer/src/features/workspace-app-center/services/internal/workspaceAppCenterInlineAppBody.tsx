import { useEffect, useRef, type ReactNode } from "react";
import {
  type BrowserNodeFeature,
  type BrowserNodeNavigationPolicy
} from "@tutti-os/browser-node";
import { BrowserNode } from "@tutti-os/browser-node/react";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { cn, Spinner } from "@tutti-os/ui-system";
import { useSnapshot } from "valtio";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterViewState
} from "@tutti-os/workspace-app-center";
import { resolveWorkspaceAppStatusPresentation } from "@tutti-os/workspace-app-center/core";
import { createAppCenterI18nRuntime } from "@tutti-os/workspace-app-center/i18n";
import type { WorkbenchHostNodeBodyContext } from "@tutti-os/workbench-surface";
import { WorkspaceAppCenterPane } from "../../ui/WorkspaceAppCenterPane.tsx";
import type { IWorkspaceAppCenterService } from "../workspaceAppCenterService.interface";
import { readWorkspaceAppTabIds } from "../workspaceAppCenterTabs.ts";
import {
  findWorkspaceApp,
  readWorkspaceAppOpenRouteIntent,
  resolveWorkspaceAppOpenUrl,
  workspaceAppInlineBrowserNodeId
} from "./workspaceAppCenterLaunchRequest.ts";
import {
  shouldPreserveWorkspaceAppWebviewDuringHandoff,
  shouldRenderWorkspaceAppBrowserNode,
  shouldSyncWorkspaceAppWebviewDefaultUrl
} from "./workspaceAppCenterWebviewHandoff.ts";

export const workspaceAppBrowserPartitionPrefix = "persist:tutti-app:";

export function WorkspaceAppCenterInlineAppBody({
  appCenterService,
  browserFeature,
  context,
  fallbackLabel,
  i18n,
  workspaceId
}: {
  appCenterService: IWorkspaceAppCenterService;
  browserFeature: BrowserNodeFeature;
  context: WorkbenchHostNodeBodyContext<
    WorkspaceAppCenterViewState | null,
    unknown
  >;
  fallbackLabel: string;
  i18n: I18nRuntime<string>;
  workspaceId: string;
}): ReactNode {
  const state = useSnapshot(appCenterService.store);
  const viewState =
    state.viewStateByWorkspaceId[workspaceId] ??
    appCenterService.getViewState(workspaceId, context.externalNodeState);
  const activeAppId = viewState.openAppId?.trim() ?? "";
  const availableAppIds =
    state.loadStatus === "ready" && state.workspaceId === workspaceId
      ? new Set(state.apps.map((app) => app.appId))
      : null;
  const openAppIds = readWorkspaceAppTabIds(
    viewState as WorkspaceAppCenterViewState
  ).filter((appId) => !availableAppIds || availableAppIds.has(appId));
  const catalogActive = !activeAppId || !openAppIds.includes(activeAppId);

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <div
        aria-hidden={!catalogActive}
        className={cn(
          "absolute inset-0",
          !catalogActive && "invisible pointer-events-none"
        )}
      >
        <WorkspaceAppCenterPane
          restoredViewState={context.externalNodeState}
          workspaceId={workspaceId}
        />
      </div>
      {openAppIds.map((openAppId) => {
        const app = findWorkspaceApp(appCenterService, openAppId);
        const isActive = !catalogActive && openAppId === activeAppId;
        return (
          <div
            aria-hidden={!isActive}
            className={cn(
              "absolute inset-0",
              !isActive && "invisible pointer-events-none"
            )}
            key={openAppId}
          >
            <WorkspaceAppCenterInlineBrowser
              activationUrl={resolveWorkspaceAppInlineActivationUrl({
                app,
                appId: openAppId,
                activation: context.activation
              })}
              app={app}
              appCenterCopy={createAppCenterI18nRuntime(i18n)}
              appId={openAppId}
              browserFeature={browserFeature}
              fallbackLabel={fallbackLabel}
              hidden={context.node.isMinimized || !isActive}
              navigationPolicy={resolveWorkspaceAppNavigationPolicy(app)}
              nodeId={workspaceAppInlineBrowserNodeId(openAppId)}
              onFocusRequest={
                !isActive || context.isFocused
                  ? undefined
                  : () => context.focus()
              }
              sessionPartition={workspaceAppBrowserSessionPartition({
                appId: openAppId,
                workspaceId
              })}
            />
          </div>
        );
      })}
    </div>
  );
}

function WorkspaceAppCenterInlineBrowser({
  activationUrl,
  app,
  appCenterCopy,
  appId,
  browserFeature,
  fallbackLabel,
  hidden,
  navigationPolicy,
  nodeId,
  onFocusRequest,
  sessionPartition
}: {
  activationUrl: string | null;
  app: WorkspaceAppCenterApp | null;
  appCenterCopy: ReturnType<typeof createAppCenterI18nRuntime>;
  appId: string;
  browserFeature: BrowserNodeFeature;
  fallbackLabel: string;
  hidden: boolean;
  navigationPolicy: BrowserNodeNavigationPolicy | null;
  nodeId: string;
  onFocusRequest?: () => void;
  sessionPartition: string;
}): ReactNode {
  const recentHandoffAppIdRef = useRef<string | null>(null);
  const defaultUrl = activationUrl ?? app?.launchUrl ?? "about:blank";
  const handoffOptions = {
    hadRecentHandoff: recentHandoffAppIdRef.current === appId
  };
  const hasDirectHandoffState =
    shouldPreserveWorkspaceAppWebviewDuringHandoff(app);
  const preserveWebviewDuringHandoff =
    shouldPreserveWorkspaceAppWebviewDuringHandoff(app, handoffOptions);
  const syncDefaultUrl = shouldSyncWorkspaceAppWebviewDefaultUrl(
    app,
    handoffOptions
  );
  const shouldRenderBrowserNode = shouldRenderWorkspaceAppBrowserNode(
    app,
    defaultUrl,
    handoffOptions
  );

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
      <WorkspaceAppCenterInlineLoadingState
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
        hidden={hidden}
        navigationPolicy={navigationPolicy}
        nodeId={nodeId}
        onFocusRequest={onFocusRequest}
        sessionPartition={sessionPartition}
        showHeader={false}
        syncDefaultUrl={syncDefaultUrl}
      />
      {preserveWebviewDuringHandoff ? (
        <div className="pointer-events-auto absolute inset-0 z-20">
          <WorkspaceAppCenterInlineLoadingState
            app={app}
            copy={appCenterCopy}
            fallbackLabel={fallbackLabel}
          />
        </div>
      ) : null}
    </div>
  );
}

function resolveWorkspaceAppInlineActivationUrl(input: {
  activation: WorkbenchHostNodeBodyContext<unknown, unknown>["activation"];
  app: WorkspaceAppCenterApp | null;
  appId: string;
}): string | null {
  if (
    input.activation?.type !== "workspace-app:open" ||
    !input.activation.payload ||
    typeof input.activation.payload !== "object" ||
    !input.app?.launchUrl
  ) {
    return null;
  }
  const payload = input.activation.payload as {
    appId?: unknown;
    intent?: unknown;
  };
  if (payload.appId !== input.appId) {
    return null;
  }
  const intent = readWorkspaceAppOpenRouteIntent(payload.intent);
  return intent
    ? resolveWorkspaceAppOpenUrl(input.app.launchUrl, intent)
    : input.app.launchUrl;
}

function WorkspaceAppCenterInlineLoadingState({
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

function resolveWorkspaceAppNavigationPolicy(
  app: WorkspaceAppCenterApp | null
): BrowserNodeNavigationPolicy | null {
  const originUrl = app?.launchUrl?.trim() ?? "";
  return originUrl && originUrl !== "about:blank"
    ? { mode: "same-origin", originUrl }
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
