import type {
  BrowserNodeEvent,
  BrowserNodeFeature,
  BrowserNodeHostApi,
  BrowserNodeOpenUrlEvent
} from "@tutti-os/browser-node";
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
}

export function createWorkspaceBrowserService(
  input: {
    browserApi?: BrowserNodeHostApi;
  } = {}
): WorkspaceBrowserService {
  const connectedFeatures = new WeakSet<BrowserNodeFeature>();
  const routes = new Set<WorkspaceBrowserEventRoute>();
  let disconnectBrowserEvents: (() => void) | null = null;

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
    }
  };
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
