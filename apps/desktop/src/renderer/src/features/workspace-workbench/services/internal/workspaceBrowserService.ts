import type {
  BrowserNodeEvent,
  BrowserNodeFeature,
  BrowserNodeHostApi,
  BrowserNodeOpenUrlEvent
} from "@tutti-os/browser-node";
import { closeBrowserNodeTab } from "@tutti-os/browser-node";
import type { DesktopBrowserApi } from "@preload/types";
import { requestWorkspaceBrowserLaunch } from "../workspaceBrowserLaunchCoordinator.ts";

export type WorkspaceBrowserEventMatcher = (event: BrowserNodeEvent) => boolean;

export interface WorkspaceBrowserFeatureHostApiInput {
  acceptsEvent: WorkspaceBrowserEventMatcher;
  observeEvent?: (event: BrowserNodeEvent) => void;
  source?: "browser" | "workspace_app";
  workspaceId: string;
}

export interface WorkspaceBrowserService {
  createFeatureHostApi(
    input: WorkspaceBrowserFeatureHostApiInput
  ): BrowserNodeHostApi;
  ensureFeatureConnected(feature: BrowserNodeFeature): void;
  setUserAutomationSurface(input: {
    feature: BrowserNodeFeature;
    workspaceId: string;
  }): void;
}

export function createWorkspaceBrowserService(
  input: {
    browserApi?: BrowserNodeHostApi &
      Partial<
        Pick<
          DesktopBrowserApi,
          | "announceAutomationHostReady"
          | "onAutomationRequest"
          | "respondAutomationRequest"
        >
      >;
  } = {}
): WorkspaceBrowserService {
  const connectedFeatures = new WeakSet<BrowserNodeFeature>();
  const routes = new Set<WorkspaceBrowserEventRoute>();
  let disconnectBrowserEvents: (() => void) | null = null;
  let disconnectUserAutomation: (() => void) | null = null;

  const ensureBrowserEventsConnected = () => {
    if (disconnectBrowserEvents) {
      return;
    }

    if (!input.browserApi) {
      return;
    }

    disconnectBrowserEvents = input.browserApi.onEvent((event) => {
      let launchWorkspaceId: string | null = null;
      let launchSource: "browser" | "workspace_app" | undefined;
      for (const route of routes) {
        if (route.listeners.size === 0) {
          continue;
        }
        if (!route.acceptsEvent(event)) {
          continue;
        }
        if (event.type === "open-url" && launchWorkspaceId === null) {
          launchWorkspaceId = route.workspaceId;
          launchSource = route.source;
        }
        route.observeEvent?.(event);
        for (const listener of route.listeners) {
          listener(event);
        }
      }
      if (launchWorkspaceId && event.type === "open-url") {
        launchOpenUrl(event, launchWorkspaceId, launchSource);
      }
    });
  };

  const maybeDisconnectBrowserEvents = () => {
    if (!disconnectBrowserEvents) {
      return;
    }
    for (const route of routes) {
      if (route.listeners.size > 0) {
        return;
      }
    }
    disconnectBrowserEvents();
    disconnectBrowserEvents = null;
  };

  return {
    createFeatureHostApi({ acceptsEvent, observeEvent, source, workspaceId }) {
      if (!input.browserApi) {
        throw new Error("Workspace browser service requires a browser API");
      }
      const route: WorkspaceBrowserEventRoute = {
        acceptsEvent,
        listeners: new Set(),
        observeEvent,
        source,
        workspaceId
      };
      routes.add(route);
      const featureApi = { ...input.browserApi };
      if (source === "workspace_app") {
        delete featureApi.discoverChromeCookieProfiles;
        delete featureApi.importChromeCookies;
        delete featureApi.cancelChromeCookieImport;
      }
      return {
        ...featureApi,
        onEvent(listener) {
          route.listeners.add(listener);
          ensureBrowserEventsConnected();
          return () => {
            route.listeners.delete(listener);
            maybeDisconnectBrowserEvents();
          };
        }
      };
    },
    ensureFeatureConnected(feature) {
      if (connectedFeatures.has(feature)) {
        return;
      }

      feature.connect();
      connectedFeatures.add(feature);
    },
    setUserAutomationSurface({ feature, workspaceId }) {
      disconnectUserAutomation?.();
      disconnectUserAutomation =
        input.browserApi?.onAutomationRequest?.((request) => {
          if (
            request.workspaceId !== workspaceId ||
            request.surfaceRole !== "user"
          ) {
            return;
          }
          try {
            const anchorNodeId = request.nodeId?.trim() ?? "";
            const surfaceNodeId = resolveBrowserSurfaceNodeId(anchorNodeId);
            const state = surfaceNodeId
              ? feature.tabsStore.getSurfaceState(surfaceNodeId)
              : null;
            if (!surfaceNodeId || !state) {
              throw new Error("No user Browser surface is available");
            }
            if (request.action === "create") {
              const tab = feature.tabsStore.addTab(
                surfaceNodeId,
                request.url?.trim() || "about:blank"
              );
              input.browserApi?.respondAutomationRequest?.({
                nodeId: tab.nodeId,
                ok: true,
                requestId: request.requestId
              });
              return;
            }
            const tab = state.tabs.find(
              (candidate) => candidate.nodeId === anchorNodeId
            );
            if (!tab) {
              throw new Error(
                `User Browser page is unavailable: ${anchorNodeId}`
              );
            }
            if (request.action === "select") {
              feature.tabsStore.selectTab(surfaceNodeId, tab.id);
            } else {
              if (state.tabs.length === 1) {
                throw new Error("The final user Browser page cannot be closed");
              }
              closeBrowserNodeTab(feature, surfaceNodeId, tab.id);
            }
            input.browserApi?.respondAutomationRequest?.({
              nodeId: anchorNodeId,
              ok: true,
              requestId: request.requestId
            });
          } catch (error) {
            input.browserApi?.respondAutomationRequest?.({
              error: error instanceof Error ? error.message : String(error),
              ok: false,
              requestId: request.requestId
            });
          }
        }) ?? null;
      input.browserApi?.announceAutomationHostReady?.({
        surfaceRole: "user",
        workspaceId
      });
    }
  };
}

function resolveBrowserSurfaceNodeId(nodeId: string): string | null {
  const separatorIndex = nodeId.lastIndexOf(":tab:");
  return separatorIndex > 0 ? nodeId.slice(0, separatorIndex) : null;
}

interface WorkspaceBrowserEventRoute {
  acceptsEvent: WorkspaceBrowserEventMatcher;
  listeners: Set<(event: BrowserNodeEvent) => void>;
  observeEvent?: (event: BrowserNodeEvent) => void;
  source?: "browser" | "workspace_app";
  workspaceId: string;
}

function launchOpenUrl(
  event: BrowserNodeOpenUrlEvent,
  workspaceId: string,
  source?: "browser" | "workspace_app"
) {
  void requestWorkspaceBrowserLaunch({
    reuseIfOpen: event.reuseIfOpen,
    ...(source ? { source } : {}),
    url: event.url,
    workspaceId
  });
}
