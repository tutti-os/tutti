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

test("workspace browser service opens Browser popups in tabs and launches app URLs", async () => {
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
      source: "browser",
      workspaceId: "workspace-browser-open-url"
    })
  });
  const appFeature = createBrowserNodeFeature({
    hostApi: service.createFeatureHostApi({
      acceptsEvent: (event) => workspaceAppOwnsEvent(event),
      source: "workspace_app",
      workspaceId: "workspace-browser-open-url"
    })
  });
  const surfaceNodeId = "browser:surface-1";
  const initial = browserFeature.tabsStore.ensureSurface(
    surfaceNodeId,
    "https://www.baidu.com/"
  );
  const disposeLaunchHandler = registerWorkspaceBrowserLaunchHandler(
    "workspace-browser-open-url",
    (request) => {
      requests.push(request);
      return "browser:opened";
    }
  );

  service.ensureFeatureConnected(browserFeature);
  service.ensureFeatureConnected(appFeature);
  emitDesktopBrowserEvent({
    reuseIfOpen: true,
    sourceNodeId: initial.tabs[0]!.nodeId,
    type: "open-url",
    url: "https://www.baidu.com/s?wd=tutti"
  });
  emitDesktopBrowserEvent({
    reuseIfOpen: false,
    sourceNodeId: "workspace-app:99",
    type: "open-url",
    url: "https://example.com/app-popup"
  });
  await Promise.resolve();

  disposeLaunchHandler();
  const browserTabs = browserFeature.tabsStore.getSurfaceState(surfaceNodeId);
  assert.equal(browserTabs?.tabs.length, 2);
  assert.equal(
    browserTabs?.tabs.find((tab) => tab.id === browserTabs.activeTabId)
      ?.defaultUrl,
    "https://www.baidu.com/s?wd=tutti"
  );
  assert.deepEqual(requests, [
    {
      kind: "open",
      reuseIfOpen: false,
      source: "workspace_app",
      url: "https://example.com/app-popup",
      workspaceId: "workspace-browser-open-url"
    }
  ]);
});

test("workspace browser service reuses matching pages and creates tabs for new URLs", () => {
  const service = createWorkspaceBrowserService({
    browserApi: createBrowserNodeHostApi()
  });
  const feature = createBrowserNodeFeature({
    hostApi: service.createFeatureHostApi({
      acceptsEvent: (event) => browserNodeOwnsEvent(event),
      source: "browser",
      workspaceId: "workspace-page-reuse"
    })
  });
  const olderSurfaceId = "browser:older";
  const recentSurfaceId = "browser:recent";
  const pageA = feature.tabsStore.ensureSurface(
    olderSurfaceId,
    "https://example.com/a"
  ).tabs[0]!;
  const pageB = feature.tabsStore.addTab(
    olderSurfaceId,
    "https://example.com/b"
  );
  feature.tabsStore.ensureSurface(
    recentSurfaceId,
    "https://example.com/current"
  );
  service.ensureFeatureConnected(feature);

  assert.deepEqual(
    service.openPage({
      surfaceNodeIds: [recentSurfaceId, olderSurfaceId],
      url: "https://example.com/a",
      workspaceId: "workspace-page-reuse"
    }),
    {
      pageNodeId: pageA.nodeId,
      surfaceNodeId: olderSurfaceId
    }
  );
  assert.equal(
    feature.tabsStore.getSurfaceState(olderSurfaceId)?.activeTabId,
    pageA.id
  );
  assert.notEqual(pageA.id, pageB.id);

  const opened = service.openPage({
    surfaceNodeIds: [recentSurfaceId, olderSurfaceId],
    url: "https://example.com/new",
    workspaceId: "workspace-page-reuse"
  });
  assert.equal(opened?.surfaceNodeId, recentSurfaceId);
  assert.equal(
    feature.tabsStore
      .getSurfaceState(recentSurfaceId)
      ?.tabs.find((tab) => tab.nodeId === opened?.pageNodeId)?.defaultUrl,
    "https://example.com/new"
  );
  assert.equal(
    feature.tabsStore.getSurfaceState(olderSurfaceId)?.tabs.length,
    2
  );
  assert.equal(
    feature.tabsStore.getSurfaceState(recentSurfaceId)?.tabs.length,
    2
  );
});

test("workspace browser service reuses a redirected tab while another tab is selected", () => {
  const service = createWorkspaceBrowserService({
    browserApi: createBrowserNodeHostApi()
  });
  const feature = createBrowserNodeFeature({
    hostApi: service.createFeatureHostApi({
      acceptsEvent: (event) => browserNodeOwnsEvent(event),
      source: "browser",
      workspaceId: "workspace-redirected-page-reuse"
    })
  });
  const surfaceNodeId = "browser:redirected-page-reuse";
  feature.tabsStore.ensureSurface(surfaceNodeId, "https://example.com/");
  const pageB = feature.tabsStore.addTab(
    surfaceNodeId,
    "https://www.openai.com/"
  );
  const pageC = feature.tabsStore.addTab(
    surfaceNodeId,
    "https://docs.python.org/3/"
  );
  feature.runtimeStore.applyEvent(
    createBrowserStateEvent(pageB.nodeId, "https://openai.com/")
  );
  service.ensureFeatureConnected(feature);

  const opened = service.openPage({
    surfaceNodeIds: [surfaceNodeId],
    url: "https://www.openai.com/",
    workspaceId: "workspace-redirected-page-reuse"
  });

  assert.deepEqual(opened, {
    pageNodeId: pageB.nodeId,
    surfaceNodeId
  });
  assert.equal(
    feature.tabsStore.getSurfaceState(surfaceNodeId)?.activeTabId,
    pageB.id
  );
  assert.notEqual(pageB.id, pageC.id);
  assert.equal(
    feature.tabsStore.getSurfaceState(surfaceNodeId)?.tabs.length,
    3
  );
});

test("workspace browser service replaces stale feature routes before handling popups", () => {
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
  const createFeature = () => {
    const feature = createBrowserNodeFeature({
      hostApi: service.createFeatureHostApi({
        acceptsEvent: (event) => browserNodeOwnsEvent(event),
        source: "browser",
        workspaceId: "workspace-browser-replacement"
      })
    });
    feature.tabsStore.ensureSurface(
      "browser:surface-replacement",
      "https://www.baidu.com/"
    );
    service.ensureFeatureConnected(feature);
    return feature;
  };
  const staleFeature = createFeature();
  const currentFeature = createFeature();

  emitDesktopBrowserEvent({
    reuseIfOpen: true,
    sourceNodeId: "browser:surface-replacement:tab:1",
    type: "open-url",
    url: "https://www.baidu.com/s?wd=tutti"
  });

  assert.equal(
    staleFeature.tabsStore.getSurfaceState("browser:surface-replacement")?.tabs
      .length,
    1
  );
  assert.equal(
    currentFeature.tabsStore.getSurfaceState("browser:surface-replacement")
      ?.tabs.length,
    2
  );
});

test("workspace browser service disposes routes with their workspace session", () => {
  let desktopDisconnectCount = 0;
  let emitDesktopBrowserEvent = (_event: BrowserNodeEvent): void => undefined;
  const service = createWorkspaceBrowserService({
    browserApi: createBrowserNodeHostApi({
      onEvent(listener) {
        emitDesktopBrowserEvent = listener;
        return () => {
          desktopDisconnectCount += 1;
          emitDesktopBrowserEvent = () => undefined;
        };
      }
    })
  });
  const createFeature = (workspaceId: string, nodeIdPrefix: string) => {
    const feature = createBrowserNodeFeature({
      hostApi: service.createFeatureHostApi({
        acceptsEvent: (event) => {
          const nodeId =
            event.type === "open-url" ? event.sourceNodeId : event.nodeId;
          return nodeId.startsWith(nodeIdPrefix);
        },
        source: "browser",
        workspaceId
      })
    });
    service.ensureFeatureConnected(feature);
    return feature;
  };
  const disposedFeature = createFeature("workspace-disposed", "browser-old:");
  const activeFeature = createFeature("workspace-active", "browser-active:");

  service.disposeWorkspace("workspace-disposed");
  emitDesktopBrowserEvent({
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "browser-old:tab:1",
    title: "Disposed",
    type: "state",
    url: "https://disposed.example/"
  });
  emitDesktopBrowserEvent({
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "browser-active:tab:1",
    title: "Active",
    type: "state",
    url: "https://active.example/"
  });

  assert.equal(
    disposedFeature.runtimeStore.getNodeState("browser-old:tab:1").url,
    null
  );
  assert.equal(
    activeFeature.runtimeStore.getNodeState("browser-active:tab:1").url,
    "https://active.example/"
  );
  assert.equal(desktopDisconnectCount, 0);

  service.disposeWorkspace("workspace-active");
  assert.equal(desktopDisconnectCount, 1);
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

test("workspace browser service reveals only the requested user automation page", async () => {
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
  const focusRequests: WorkspaceBrowserLaunchRequest[] = [];
  const disposeLaunchHandler = registerWorkspaceBrowserLaunchHandler(
    "workspace-1",
    (request) => {
      focusRequests.push(request);
      return surfaceNodeId;
    }
  );
  service.setUserAutomationSurface({
    feature,
    workspaceId: "workspace-1"
  });

  handleRequest({
    action: "create",
    agentSessionId: "agent-1",
    nodeId: initial.tabs[0]!.nodeId,
    reveal: true,
    requestId: "create-1",
    surfaceRole: "user",
    url: "https://created.example/",
    workspaceId: "workspace-1"
  });
  await Promise.resolve();
  await Promise.resolve();
  const createdNodeId = responses[0]?.ok ? responses[0].nodeId : null;
  assert.ok(createdNodeId);
  assert.equal(
    feature.tabsStore
      .getSurfaceState(surfaceNodeId)
      ?.tabs.find((tab) => tab.nodeId === createdNodeId)?.defaultUrl,
    "https://created.example/"
  );
  assert.equal(
    feature.tabsStore
      .getSurfaceState(surfaceNodeId)
      ?.tabs.find((tab) => tab.nodeId === createdNodeId)?.materializeCold,
    true
  );

  handleRequest({
    action: "create",
    agentSessionId: "agent-1",
    nodeId: createdNodeId,
    reveal: false,
    requestId: "create-2",
    surfaceRole: "user",
    url: "https://background.example/",
    workspaceId: "workspace-1"
  });
  await Promise.resolve();
  await Promise.resolve();
  const backgroundNodeId = responses[1]?.ok ? responses[1].nodeId : null;
  assert.ok(backgroundNodeId);
  assert.equal(
    feature.tabsStore
      .getSurfaceState(surfaceNodeId)
      ?.tabs.find((tab) => tab.nodeId === backgroundNodeId)?.defaultUrl,
    "https://background.example/"
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
    2
  );
  assert.deepEqual(
    responses.map((response) => response.ok),
    [true, true, true]
  );
  assert.deepEqual(focusRequests, [
    {
      kind: "focus",
      preferredNodeId: surfaceNodeId,
      workspaceId: "workspace-1"
    }
  ]);
  disposeLaunchHandler();
});

test("workspace browser service creates the first automation page in a newly focused Browser", async () => {
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
  const surfaceNodeId = "browser:new-window";
  const disposeLaunchHandler = registerWorkspaceBrowserLaunchHandler(
    "workspace-new-browser",
    () => surfaceNodeId
  );
  service.setUserAutomationSurface({
    feature,
    workspaceId: "workspace-new-browser"
  });

  handleRequest({
    action: "create",
    agentSessionId: "agent-1",
    nodeId: null,
    requestId: "create-first",
    surfaceRole: "user",
    url: "about:blank",
    workspaceId: "workspace-new-browser"
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(responses, [
    {
      nodeId: `${surfaceNodeId}:tab:1`,
      ok: true,
      requestId: "create-first"
    }
  ]);
  assert.equal(
    feature.tabsStore.getSurfaceState(surfaceNodeId)?.tabs.length,
    1
  );
  assert.equal(
    feature.tabsStore.getSurfaceState(surfaceNodeId)?.tabs[0]?.materializeCold,
    true
  );
  disposeLaunchHandler();
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

function createBrowserStateEvent(
  nodeId: string,
  url: string
): BrowserNodeEvent {
  return {
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId,
    title: null,
    type: "state",
    url
  };
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
