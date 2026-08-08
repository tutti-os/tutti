import type {
  BrowserNodeEvent,
  BrowserNodeFeature,
  BrowserNodeHostApi,
  BrowserNodeOpenUrlEvent
} from "@tutti-os/browser-node";
import { closeBrowserNodeTab } from "@tutti-os/browser-node";
import type { DesktopBrowserApi } from "@preload/types";
import {
  requestWorkspaceBrowserLaunch,
  requestWorkspaceBrowserNodeLaunch,
  requestWorkspaceBrowserSurfaceFocus
} from "../workspaceBrowserLaunchCoordinator.ts";

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
  disposeWorkspace(workspaceId: string): void;
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
  const routes = new Set<WorkspaceBrowserEventRoute>();
  const routesByHostApi = new WeakMap<
    BrowserNodeHostApi,
    WorkspaceBrowserEventRoute
  >();
  const featureReleases = new WeakMap<BrowserNodeFeature, () => void>();
  const activeRoutesByWorkspace: WorkspaceBrowserRoutesByWorkspace = new Map();
  const workspaceAppPopupsByWorkspace = new Map<
    string,
    WorkspaceAppPopupTracking
  >();
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
      let openUrlHandled = false;
      for (const route of routes) {
        if (route.listeners.size === 0) {
          continue;
        }
        if (!route.acceptsEvent(event)) {
          continue;
        }
        if (event.type === "open-url") {
          if (
            route.source === "browser" &&
            event.reuseIfOpen !== false &&
            !openUrlHandled
          ) {
            const feature = route.feature;
            openUrlHandled = feature
              ? openBrowserUrlInNewTab(feature, event)
              : false;
          }
          if (!openUrlHandled && launchWorkspaceId === null) {
            launchWorkspaceId = route.workspaceId;
            launchSource = route.source;
          }
        }
        route.observeEvent?.(event);
        for (const listener of route.listeners) {
          listener(event);
        }
      }
      if (launchWorkspaceId && event.type === "open-url" && !openUrlHandled) {
        launchOpenUrl({
          activeRoutesByWorkspace,
          event,
          source: launchSource,
          trackingByWorkspace: workspaceAppPopupsByWorkspace,
          workspaceId: launchWorkspaceId
        });
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

  const disposeRoute = (route: WorkspaceBrowserEventRoute): void => {
    const feature = route.feature;
    route.releaseFeature?.();
    if (feature) {
      featureReleases.delete(feature);
    }
    route.releaseFeature = null;
    route.feature = null;
    routes.delete(route);
    routesByHostApi.delete(route.hostApi);
    if (route.source) {
      const activeRoutes = activeRoutesByWorkspace.get(route.workspaceId);
      if (activeRoutes?.get(route.source) === route) {
        activeRoutes.delete(route.source);
        if (activeRoutes.size === 0) {
          activeRoutesByWorkspace.delete(route.workspaceId);
        }
      }
    }
    maybeDisconnectBrowserEvents();
  };

  const replaceActiveRoute = (route: WorkspaceBrowserEventRoute): void => {
    if (!route.source) {
      return;
    }
    const previousRoute = activeRoutesByWorkspace
      .get(route.workspaceId)
      ?.get(route.source);
    if (previousRoute && previousRoute !== route) {
      disposeRoute(previousRoute);
    }
    const activeRoutes =
      activeRoutesByWorkspace.get(route.workspaceId) ??
      new Map<WorkspaceBrowserFeatureSource, WorkspaceBrowserEventRoute>();
    activeRoutes.set(route.source, route);
    activeRoutesByWorkspace.set(route.workspaceId, activeRoutes);
  };

  return {
    createFeatureHostApi({ acceptsEvent, observeEvent, source, workspaceId }) {
      if (!input.browserApi) {
        throw new Error("Workspace browser service requires a browser API");
      }
      const listeners = new Set<(event: BrowserNodeEvent) => void>();
      const featureApi = { ...input.browserApi };
      if (source === "workspace_app") {
        delete featureApi.discoverChromeCookieProfiles;
        delete featureApi.importChromeCookies;
        delete featureApi.cancelChromeCookieImport;
      }
      const hostApi: BrowserNodeHostApi = {
        ...featureApi,
        onEvent(listener) {
          listeners.add(listener);
          ensureBrowserEventsConnected();
          return () => {
            listeners.delete(listener);
            maybeDisconnectBrowserEvents();
          };
        }
      };
      const route: WorkspaceBrowserEventRoute = {
        acceptsEvent,
        feature: null,
        hostApi,
        listeners,
        observeEvent,
        releaseFeature: null,
        source,
        workspaceId
      };
      routes.add(route);
      routesByHostApi.set(hostApi, route);
      return hostApi;
    },
    disposeWorkspace(workspaceId) {
      for (const route of Array.from(routes)) {
        if (route.workspaceId === workspaceId) {
          disposeRoute(route);
        }
      }
      workspaceAppPopupsByWorkspace.delete(workspaceId);
    },
    ensureFeatureConnected(feature) {
      if (featureReleases.has(feature)) {
        return;
      }
      const route = routesByHostApi.get(feature.hostApi);
      const releaseFeature = feature.connect();
      featureReleases.set(feature, releaseFeature);
      if (!route) {
        return;
      }
      route.feature = feature;
      route.releaseFeature = releaseFeature;
      replaceActiveRoute(route);
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
          void (async () => {
            try {
              const anchorNodeId = request.nodeId?.trim() ?? "";
              let surfaceNodeId = resolveBrowserSurfaceNodeId(anchorNodeId);
              if (request.action === "create") {
                if (request.reveal !== false) {
                  surfaceNodeId = await requestWorkspaceBrowserSurfaceFocus({
                    preferredNodeId: surfaceNodeId,
                    workspaceId
                  });
                }
                if (!surfaceNodeId) {
                  throw new Error("No user Browser surface is available");
                }
                const pageUrl = request.url?.trim() || "about:blank";
                const state = feature.tabsStore.getSurfaceState(surfaceNodeId);
                const tab = state
                  ? feature.tabsStore.addTab(surfaceNodeId, pageUrl, {
                      materializeCold: true
                    })
                  : feature.tabsStore.ensureSurface(surfaceNodeId, pageUrl, {
                      materializeCold: true
                    }).tabs[0];
                if (!tab) {
                  throw new Error("User Browser page was not created");
                }
                input.browserApi?.respondAutomationRequest?.({
                  nodeId: tab.nodeId,
                  ok: true,
                  requestId: request.requestId
                });
                return;
              }
              const state = surfaceNodeId
                ? feature.tabsStore.getSurfaceState(surfaceNodeId)
                : null;
              if (!surfaceNodeId || !state) {
                throw new Error("No user Browser surface is available");
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
                  throw new Error(
                    "The final user Browser page cannot be closed"
                  );
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
          })();
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
  feature: BrowserNodeFeature | null;
  hostApi: BrowserNodeHostApi;
  listeners: Set<(event: BrowserNodeEvent) => void>;
  observeEvent?: (event: BrowserNodeEvent) => void;
  releaseFeature: (() => void) | null;
  source?: "browser" | "workspace_app";
  workspaceId: string;
}

type WorkspaceBrowserFeatureSource = NonNullable<
  WorkspaceBrowserEventRoute["source"]
>;

type WorkspaceBrowserRoutesByWorkspace = Map<
  string,
  Map<WorkspaceBrowserFeatureSource, WorkspaceBrowserEventRoute>
>;

function openBrowserUrlInNewTab(
  feature: BrowserNodeFeature,
  event: BrowserNodeOpenUrlEvent
): boolean {
  const surfaceNodeId = resolveBrowserSurfaceNodeId(event.sourceNodeId);
  const state = surfaceNodeId
    ? feature.tabsStore.getSurfaceState(surfaceNodeId)
    : null;
  if (
    !surfaceNodeId ||
    !state?.tabs.some((tab) => tab.nodeId === event.sourceNodeId)
  ) {
    return false;
  }

  feature.tabsStore.addTab(surfaceNodeId, event.url);
  return true;
}

interface WorkspaceAppPopupTracking {
  inFlightByRequest: Map<string, Promise<void>>;
  nodeByRequest: Map<string, string>;
}

function launchOpenUrl(input: {
  activeRoutesByWorkspace: WorkspaceBrowserRoutesByWorkspace;
  event: BrowserNodeOpenUrlEvent;
  source?: "browser" | "workspace_app";
  trackingByWorkspace: Map<string, WorkspaceAppPopupTracking>;
  workspaceId: string;
}): void {
  if (input.source !== "workspace_app" || input.event.reuseIfOpen !== false) {
    void requestWorkspaceBrowserLaunch({
      reuseIfOpen: input.event.reuseIfOpen,
      ...(input.source ? { source: input.source } : {}),
      sourceNodeId: input.event.sourceNodeId,
      url: input.event.url,
      workspaceId: input.workspaceId
    });
    return;
  }

  const tracking =
    input.trackingByWorkspace.get(input.workspaceId) ??
    createWorkspaceAppPopupTracking();
  input.trackingByWorkspace.set(input.workspaceId, tracking);
  const normalizedUrl = normalizeComparableBrowserUrl(input.event.url);
  if (!normalizedUrl) {
    return;
  }
  const requestKey = JSON.stringify([input.event.sourceNodeId, normalizedUrl]);
  if (tracking.inFlightByRequest.has(requestKey)) {
    return;
  }

  let openRequest!: Promise<void>;
  openRequest = openWorkspaceAppPopup({
    activeRoutesByWorkspace: input.activeRoutesByWorkspace,
    event: input.event,
    requestKey,
    tracking,
    url: normalizedUrl,
    workspaceId: input.workspaceId
  })
    .catch(() => undefined)
    .finally(() => {
      if (tracking.inFlightByRequest.get(requestKey) === openRequest) {
        tracking.inFlightByRequest.delete(requestKey);
      }
    });
  tracking.inFlightByRequest.set(requestKey, openRequest);
}

async function openWorkspaceAppPopup(input: {
  activeRoutesByWorkspace: WorkspaceBrowserRoutesByWorkspace;
  event: BrowserNodeOpenUrlEvent;
  requestKey: string;
  tracking: WorkspaceAppPopupTracking;
  url: string;
  workspaceId: string;
}): Promise<void> {
  const rememberedNodeId = input.tracking.nodeByRequest.get(input.requestKey);
  if (
    rememberedNodeId &&
    resolveBrowserSurfaceUrl({
      activeRoutesByWorkspace: input.activeRoutesByWorkspace,
      surfaceNodeId: rememberedNodeId,
      workspaceId: input.workspaceId
    }) === input.url
  ) {
    const focusedNodeId = await requestWorkspaceBrowserSurfaceFocus({
      fallbackToCurrent: false,
      preferredNodeId: rememberedNodeId,
      workspaceId: input.workspaceId
    });
    if (focusedNodeId === rememberedNodeId) {
      return;
    }
  }
  input.tracking.nodeByRequest.delete(input.requestKey);

  const nodeId = await requestWorkspaceBrowserNodeLaunch({
    reuseIfOpen: input.event.reuseIfOpen,
    source: "workspace_app",
    sourceNodeId: input.event.sourceNodeId,
    url: input.url,
    workspaceId: input.workspaceId
  });
  if (nodeId) {
    input.tracking.nodeByRequest.set(input.requestKey, nodeId);
  }
}

function createWorkspaceAppPopupTracking(): WorkspaceAppPopupTracking {
  return {
    inFlightByRequest: new Map(),
    nodeByRequest: new Map()
  };
}

function resolveBrowserSurfaceUrl(input: {
  activeRoutesByWorkspace: WorkspaceBrowserRoutesByWorkspace;
  surfaceNodeId: string;
  workspaceId: string;
}): string | null {
  const feature = input.activeRoutesByWorkspace
    .get(input.workspaceId)
    ?.get("browser")?.feature;
  const state = feature?.tabsStore.getSurfaceState(input.surfaceNodeId);
  const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
  if (!feature || !activeTab) {
    return null;
  }
  const runtimeUrl = feature.runtimeStore
    .getNodeState(activeTab.nodeId)
    .url?.trim();
  return normalizeComparableBrowserUrl(runtimeUrl || activeTab.defaultUrl);
}

function normalizeComparableBrowserUrl(url: string): string | null {
  try {
    return new URL(url.trim()).toString();
  } catch {
    return null;
  }
}
