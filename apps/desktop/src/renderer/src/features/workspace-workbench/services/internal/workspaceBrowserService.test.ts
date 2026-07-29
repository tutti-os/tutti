import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeFeature } from "@tutti-os/browser-node";
import type {
  BrowserNodeEvent,
  BrowserNodeHostApi
} from "@tutti-os/browser-node";
import type {
  DesktopBrowserAutomationRequest,
  DesktopBrowserAutomationResponse
} from "@shared/contracts/ipc";
import {
  registerWorkspaceBrowserLaunchHandler,
  type WorkspaceBrowserLaunchRequest
} from "../workspaceBrowserLaunchCoordinator.ts";
import { createWorkspaceBrowserService } from "./workspaceBrowserService.ts";

test("workspace browser service routes multiple features through one desktop subscription", () => {
  const browserEvents: BrowserNodeEvent[] = [];
  const appEvents: BrowserNodeEvent[] = [];
  let desktopSubscribeCount = 0;
  let emitDesktopBrowserEvent = (_event: BrowserNodeEvent): void => undefined;
  const service = createWorkspaceBrowserService({
    browserApi: createBrowserNodeHostApi({
      onEvent(listener) {
        desktopSubscribeCount += 1;
        emitDesktopBrowserEvent = listener;
        return () => {
          emitDesktopBrowserEvent = () => undefined;
        };
      }
    })
  });
  const browserFeature = createBrowserNodeFeature({
    hostApi: service.createFeatureHostApi({
      acceptsEvent: (event) => browserNodeOwnsEvent(event),
      observeEvent: (event) => browserEvents.push(event),
      workspaceId: "workspace-browser-routing"
    })
  });
  const appFeature = createBrowserNodeFeature({
    hostApi: service.createFeatureHostApi({
      acceptsEvent: (event) => workspaceAppOwnsEvent(event),
      observeEvent: (event) => appEvents.push(event),
      workspaceId: "workspace-browser-routing"
    })
  });

  service.ensureFeatureConnected(browserFeature);
  service.ensureFeatureConnected(browserFeature);
  service.ensureFeatureConnected(appFeature);

  emitDesktopBrowserEvent({
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "browser:node-1",
    title: "Browser",
    type: "state",
    url: "https://example.com/browser"
  });
  emitDesktopBrowserEvent({
    code: "navigation-failed",
    diagnosticMessage: "ERR_CONNECTION_REFUSED",
    nodeId: "workspace-app-webview:app-1",
    type: "error"
  });

  assert.equal(desktopSubscribeCount, 1);
  assert.equal(
    browserFeature.runtimeStore.getNodeState("browser:node-1").url,
    "https://example.com/browser"
  );
  assert.equal(
    appFeature.runtimeStore.getNodeState("browser:node-1").url,
    null
  );
  assert.deepEqual(
    appFeature.runtimeStore.getNodeState("workspace-app-webview:app-1").error,
    {
      code: "navigation-failed",
      diagnosticMessage: "ERR_CONNECTION_REFUSED",
      params: undefined
    }
  );
  assert.deepEqual(
    browserEvents.map((event) => event.type),
    ["state"]
  );
  assert.deepEqual(
    appEvents.map((event) => event.type),
    ["error"]
  );
});

test("workspace browser service launches open-url once from the owning route", async () => {
  const requests: WorkspaceBrowserLaunchRequest[] = [];
  let emitDesktopBrowserEvent = (_event: BrowserNodeEvent): void => undefined;
  const service = createWorkspaceBrowserService({
    browserApi: createBrowserNodeHostApi({
      onEvent(listener) {
        emitDesktopBrowserEvent = listener;
        return () => {
          emitDesktopBrowserEvent = () => undefined;
        };
      }
    })
  });
  const browserFeature = createBrowserNodeFeature({
    hostApi: service.createFeatureHostApi({
      acceptsEvent: (event) => browserNodeOwnsEvent(event),
      workspaceId: "workspace-browser-open-url"
    })
  });
  const appFeature = createBrowserNodeFeature({
    hostApi: service.createFeatureHostApi({
      acceptsEvent: (event) => workspaceAppOwnsEvent(event),
      workspaceId: "workspace-browser-open-url"
    })
  });
  const disposeLaunchHandler = registerWorkspaceBrowserLaunchHandler(
    "workspace-browser-open-url",
    (request) => {
      requests.push(request);
      return true;
    }
  );

  service.ensureFeatureConnected(browserFeature);
  service.ensureFeatureConnected(appFeature);
  emitDesktopBrowserEvent({
    reuseIfOpen: false,
    sourceNodeId: "browser:node-1",
    type: "open-url",
    url: "https://example.com/browser-popup"
  });
  emitDesktopBrowserEvent({
    reuseIfOpen: false,
    sourceNodeId: "workspace-app:99",
    type: "open-url",
    url: "https://example.com/app-popup"
  });
  await Promise.resolve();

  disposeLaunchHandler();
  assert.deepEqual(requests, [
    {
      reuseIfOpen: false,
      url: "https://example.com/browser-popup",
      workspaceId: "workspace-browser-open-url"
    },
    {
      reuseIfOpen: false,
      url: "https://example.com/app-popup",
      workspaceId: "workspace-browser-open-url"
    }
  ]);
});

test("workspace app Browser features do not inherit Chrome Cookie import", () => {
  const browserApi = createBrowserNodeHostApi({
    cancelChromeCookieImport: async () => undefined,
    discoverChromeCookieProfiles: async () => ({
      reason: "no-profiles",
      status: "unavailable"
    }),
    importChromeCookies: async () => ({
      canceled: false,
      failed: 0,
      imported: 0,
      partial: false,
      skipped: 0,
      status: "completed"
    })
  });
  const service = createWorkspaceBrowserService({ browserApi });
  const ordinaryApi = service.createFeatureHostApi({
    acceptsEvent: () => true,
    source: "browser",
    workspaceId: "workspace"
  });
  const workspaceAppApi = service.createFeatureHostApi({
    acceptsEvent: () => true,
    source: "workspace_app",
    workspaceId: "workspace"
  });

  assert.equal(typeof ordinaryApi.discoverChromeCookieProfiles, "function");
  assert.equal(typeof ordinaryApi.importChromeCookies, "function");
  assert.equal(typeof ordinaryApi.cancelChromeCookieImport, "function");
  assert.equal(workspaceAppApi.discoverChromeCookieProfiles, undefined);
  assert.equal(workspaceAppApi.importChromeCookies, undefined);
  assert.equal(workspaceAppApi.cancelChromeCookieImport, undefined);
});

test("workspace browser service owns user automation tab lifecycle", () => {
  let handleRequest = (_request: DesktopBrowserAutomationRequest): void =>
    undefined;
  const responses: DesktopBrowserAutomationResponse[] = [];
  const browserApi = {
    ...createBrowserNodeHostApi(),
    onAutomationRequest(listener: typeof handleRequest) {
      handleRequest = listener;
      return () => {
        handleRequest = () => undefined;
      };
    },
    respondAutomationRequest(response: DesktopBrowserAutomationResponse) {
      responses.push(response);
    }
  };
  const service = createWorkspaceBrowserService({ browserApi });
  const feature = createBrowserNodeFeature({ hostApi: browserApi });
  const surfaceNodeId = "workspace-browser:instance-1";
  const initial = feature.tabsStore.ensureSurface(
    surfaceNodeId,
    "https://example.com/"
  );
  service.setUserAutomationSurface({
    feature,
    workspaceId: "workspace-1"
  });

  handleRequest({
    action: "create",
    agentSessionId: "agent-1",
    nodeId: initial.tabs[0]!.nodeId,
    requestId: "create-1",
    surfaceRole: "user",
    url: "https://created.example/",
    workspaceId: "workspace-1"
  });
  const createdNodeId = responses[0]?.ok ? responses[0].nodeId : null;
  assert.ok(createdNodeId);
  assert.equal(
    feature.tabsStore
      .getSurfaceState(surfaceNodeId)
      ?.tabs.find((tab) => tab.nodeId === createdNodeId)?.defaultUrl,
    "https://created.example/"
  );

  handleRequest({
    action: "close",
    agentSessionId: "agent-1",
    nodeId: createdNodeId,
    requestId: "close-1",
    surfaceRole: "user",
    url: null,
    workspaceId: "workspace-1"
  });
  assert.equal(
    feature.tabsStore.getSurfaceState(surfaceNodeId)?.tabs.length,
    1
  );
  assert.deepEqual(
    responses.map((response) => response.ok),
    [true, true]
  );
});

function browserNodeOwnsEvent(event: BrowserNodeEvent): boolean {
  const nodeId = event.type === "open-url" ? event.sourceNodeId : event.nodeId;
  return nodeId.startsWith("browser:");
}

function workspaceAppOwnsEvent(event: BrowserNodeEvent): boolean {
  const nodeId = event.type === "open-url" ? event.sourceNodeId : event.nodeId;
  return (
    nodeId.startsWith("workspace-app-webview:") ||
    nodeId.startsWith("workspace-app:")
  );
}

function createBrowserNodeHostApi(
  overrides: Partial<BrowserNodeHostApi> = {}
): BrowserNodeHostApi {
  return {
    ...overrides,
    activate: overrides.activate ?? (() => Promise.resolve()),
    close: overrides.close ?? (() => Promise.resolve()),
    goBack: overrides.goBack ?? (() => Promise.resolve()),
    goForward: overrides.goForward ?? (() => Promise.resolve()),
    navigate: overrides.navigate ?? (() => Promise.resolve()),
    onEvent: overrides.onEvent ?? (() => () => undefined),
    prepareSession: overrides.prepareSession ?? (() => Promise.resolve()),
    registerGuest: overrides.registerGuest ?? (() => Promise.resolve()),
    reload: overrides.reload ?? (() => Promise.resolve()),
    unregisterGuest: overrides.unregisterGuest ?? (() => Promise.resolve())
  };
}
