import type {
  BrowserNodeEvent,
  BrowserNodeFeature,
  BrowserNodeHostApi,
  BrowserNodeOpenUrlEvent
} from "@tutti-os/browser-node";
import {
  activateBrowserNodePageByUrl,
  closeBrowserNodeTab
} from "@tutti-os/browser-node";
import type { DesktopBrowserApi } from "@preload/types";
import type {
  WorkspaceBrowserPageOpenInput,
  WorkspaceBrowserPageOpenResult
} from "../workspaceWorkbenchHostService.interface.ts";
import {
  requestWorkspaceBrowserLaunch,
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
  openPage(
    input: WorkspaceBrowserPageOpenInput
  ): WorkspaceBrowserPageOpenResult | null;
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
  const activeRoutesByWorkspace = new Map<
    string,
    Map<WorkspaceBrowserFeatureSource, WorkspaceBrowserEventRoute>
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
    openPage({ surfaceNodeIds, url, workspaceId }) {
      const feature = activeRoutesByWorkspace
        .get(workspaceId)
        ?.get("browser")?.feature;
      const normalizedUrl = url.trim();
      if (!feature || !normalizedUrl) {
        return null;
      }

      const eligibleSurfaceNodeIds = Array.from(
        new Set(surfaceNodeIds.map((nodeId) => nodeId.trim()).filter(Boolean))
      ).filter((nodeId) => feature.tabsStore.getSurfaceState(nodeId));
      for (const surfaceNodeId of eligibleSurfaceNodeIds) {
        const page = activateBrowserNodePageByUrl(
          feature,
          surfaceNodeId,
          normalizedUrl
        );
        if (page) {
          return { pageNodeId: page.nodeId, surfaceNodeId };
        }
      }

      const surfaceNodeId = eligibleSurfaceNodeIds[0];
      if (!surfaceNodeId) {
        return null;
      }
      const page = feature.tabsStore.addTab(surfaceNodeId, normalizedUrl);
      return { pageNodeId: page.nodeId, surfaceNodeId };
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
