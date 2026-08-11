import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeFeature } from "./feature.ts";
import { browserNodeGuestInteractionHostChannel } from "./guestInteraction.ts";
import { acquireBrowserNodeWebviewController } from "./webviewController.ts";
import type {
  BrowserNodeHostApi,
  BrowserNodePrepareSessionInput,
  BrowserNodeUpdateAutomationTargetInput
} from "./types.ts";
import type { BrowserNodeWebviewTag } from "../react/webviewTag.ts";

test("Browser Node webview controller prepares sessions when active", async () => {
  const prepareCalls: Array<{
    nodeId: string;
    profileId: string | null;
    workspaceId: string | null;
  }> = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      prepareSession(payload) {
        prepareCalls.push({
          nodeId: payload.nodeId,
          profileId: payload.profileId,
          workspaceId: payload.automationTarget?.workspaceId ?? null
        });
        return Promise.resolve();
      }
    })
  });

  const controller = acquireBrowserNodeWebviewController({
    automationTarget: {
      focused: false,
      selected: true,
      surfaceId: "surface-1",
      surfaceRole: "user",
      tabId: "tab-1",
      workspaceId: "workspace-1"
    },
    feature,
    initialUrl: "https://example.com/",
    lifecycle: "active",
    nodeId: "browser-1",
    profileId: null,
    sessionMode: "shared"
  });

  controller.retain();
  await Promise.resolve();
  assert.deepEqual(prepareCalls, [
    {
      nodeId: "browser-1",
      profileId: null,
      workspaceId: "workspace-1"
    }
  ]);
  controller.release();
});

test("Browser Node webview controller coalesces equivalent host synchronization", async () => {
  const prepareCalls: BrowserNodePrepareSessionInput[] = [];
  const automationTargetCalls: BrowserNodeUpdateAutomationTargetInput[] = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      prepareSession(payload) {
        prepareCalls.push(payload);
        return Promise.resolve();
      },
      updateAutomationTarget(payload) {
        automationTargetCalls.push(payload);
        return Promise.resolve();
      }
    })
  });
  const createController = (lifecycle: "active" | "cold", selected: boolean) =>
    acquireBrowserNodeWebviewController({
      automationTarget: {
        agentSessionId: "agent-1",
        focused: false,
        selected,
        surfaceId: "surface-1",
        surfaceRole: "agent",
        tabId: "tab-1",
        workspaceId: "workspace-1"
      },
      feature,
      initialUrl: "https://example.com/",
      lifecycle,
      navigationPolicy: {
        mode: "same-origin",
        originUrl: "https://example.com/"
      },
      nodeId: "browser-host-sync",
      profileId: null,
      sessionMode: "shared"
    });

  const controller = createController("active", true);
  controller.retain();
  controller.sync();
  createController("active", true).sync();
  await Promise.resolve();

  assert.equal(prepareCalls.length, 1);
  assert.equal(automationTargetCalls.length, 1);

  createController("active", false).sync();
  await Promise.resolve();
  assert.equal(prepareCalls.length, 2);
  assert.equal(automationTargetCalls.length, 2);
  assert.equal(prepareCalls.at(-1)?.automationTarget?.selected, false);
  assert.equal(automationTargetCalls.at(-1)?.automationTarget.selected, false);

  createController("cold", false).sync();
  createController("active", false).sync();
  await Promise.resolve();
  assert.equal(prepareCalls.length, 3);
  assert.equal(automationTargetCalls.length, 2);
  controller.release();
});

test("Browser Node webview controller derives render state and partition", () => {
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi()
  });

  const controller = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "localhost:3000",
    lifecycle: "cold",
    nodeId: "browser-2",
    profileId: null,
    sessionMode: "shared"
  });

  const state = controller.getState();
  assert.equal(state.shouldRenderWebview, false);
  assert.equal(state.webviewPartition, "persist:browser-node-shared");
  assert.equal(state.webviewKey, "browser-2:persist:browser-node-shared");
  assert.equal(state.webviewSrc, "about:blank");
});

test("Browser Node webview controller materializes only explicitly requested cold targets", () => {
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi()
  });

  const ordinaryController = acquireBrowserNodeWebviewController({
    automationTarget: {
      agentSessionId: "agent-1",
      focused: false,
      selected: true,
      surfaceId: "agent-browser",
      surfaceRole: "agent",
      tabId: "tab-1",
      workspaceId: "workspace-1"
    },
    feature,
    initialUrl: "about:blank",
    lifecycle: "cold",
    nodeId: "browser-automation-ordinary-cold",
    profileId: null,
    sessionMode: "shared"
  });

  assert.equal(ordinaryController.getState().shouldRenderWebview, false);
  ordinaryController.release();

  const pendingController = acquireBrowserNodeWebviewController({
    automationTarget: {
      agentSessionId: "agent-1",
      focused: false,
      selected: true,
      surfaceId: "agent-browser",
      surfaceRole: "agent",
      tabId: "tab-2",
      workspaceId: "workspace-1"
    },
    feature,
    initialUrl: "about:blank",
    lifecycle: "cold",
    materializeCold: true,
    nodeId: "browser-automation-pending-cold",
    profileId: null,
    sessionMode: "shared"
  });

  assert.equal(pendingController.getState().shouldRenderWebview, true);
  pendingController.release();
});

test("Browser Node webview controller tolerates webviews before dom-ready exposes webContentsId", async () => {
  const registerCalls: number[] = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      registerGuest(payload) {
        registerCalls.push(payload.webContentsId);
        return Promise.resolve();
      }
    })
  });

  const controller = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "https://example.com/",
    lifecycle: "active",
    nodeId: "browser-dom-ready-late",
    profileId: null,
    sessionMode: "shared"
  });

  const webview = new MockBrowserNodeWebviewTag(18);
  webview.throwWhenReadingWebContentsId = true;
  controller.setWebview(webview as unknown as BrowserNodeWebviewTag);
  assert.doesNotThrow(() => controller.retain());
  webview.emit("did-attach");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(registerCalls, []);

  webview.throwWhenReadingWebContentsId = false;
  webview.emit("dom-ready");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(registerCalls, [18]);
  controller.release();
});

test("Browser Node webview controller resyncs webview state when context changes for the same node", async () => {
  const prepareCalls: Array<{
    nodeId: string;
    profileId: string | null;
    sessionMode: string;
    url: string | undefined;
  }> = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      prepareSession(payload) {
        prepareCalls.push({
          nodeId: payload.nodeId,
          profileId: payload.profileId,
          sessionMode: payload.sessionMode,
          url: payload.url
        });
        return Promise.resolve();
      }
    })
  });

  const first = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "https://example.com/",
    lifecycle: "active",
    nodeId: "browser-5",
    profileId: null,
    sessionMode: "shared"
  });

  first.retain();
  first.sync();
  const second = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "https://openai.com/",
    lifecycle: "active",
    nodeId: "browser-5",
    profileId: "profile-1",
    sessionMode: "profile"
  });

  assert.equal(first, second);
  second.sync();
  const state = second.getState();
  assert.equal(state.webviewSrc, "about:blank");
  assert.equal(
    state.webviewPartition,
    "persist:browser-node-profile-profile-1"
  );
  assert.equal(
    state.webviewKey,
    "browser-5:persist:browser-node-profile-profile-1"
  );
  assert.equal(prepareCalls.at(-1)?.profileId, "profile-1");
  assert.equal(prepareCalls.at(-1)?.sessionMode, "profile");
  assert.equal(prepareCalls.at(-1)?.url, "https://openai.com/");
  second.release();
});

test("Browser Node webview controller passes the current URL when registering guests", async () => {
  const registerCalls: Array<{
    url: string | undefined;
    webContentsId: number;
  }> = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      registerGuest(payload) {
        registerCalls.push({
          url: payload.url,
          webContentsId: payload.webContentsId
        });
        return Promise.resolve();
      }
    })
  });

  const controller = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "https://openai.com/",
    lifecycle: "active",
    nodeId: "browser-register-url",
    profileId: null,
    sessionMode: "shared"
  });

  const webview = new MockBrowserNodeWebviewTag(31);
  controller.retain();
  controller.setWebview(webview as unknown as BrowserNodeWebviewTag);
  webview.emit("did-attach");
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(registerCalls, [
    {
      url: "https://openai.com/",
      webContentsId: 31
    }
  ]);
  controller.release();
});

test("Browser Node webview controller focuses from guest interaction messages only", () => {
  let guestInteractionCount = 0;
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi()
  });

  const controller = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "https://example.com/",
    lifecycle: "active",
    nodeId: "browser-guest-interaction",
    onGuestInteraction() {
      guestInteractionCount += 1;
    },
    profileId: null,
    sessionMode: "shared"
  });

  const webview = new MockBrowserNodeWebviewTag(32);
  controller.retain();
  controller.setWebview(webview as unknown as BrowserNodeWebviewTag);

  webview.emitIpcMessage("browser:unrelated");
  assert.equal(guestInteractionCount, 0);

  webview.emitIpcMessage(browserNodeGuestInteractionHostChannel);
  assert.equal(guestInteractionCount, 1);

  webview.emit("focus");
  assert.equal(guestInteractionCount, 2);

  controller.release();
});

test("Browser Node webview controller opens a devtools context menu before opening devtools", async () => {
  const openDevToolsCalls: string[] = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      openDevTools(payload) {
        openDevToolsCalls.push(payload.nodeId);
        return Promise.resolve();
      }
    })
  });

  const controller = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "https://example.com/",
    lifecycle: "active",
    nodeId: "browser-devtools",
    profileId: null,
    sessionMode: "shared"
  });

  const webview = new MockBrowserNodeWebviewTag(23);
  controller.retain();
  controller.setWebview(webview as unknown as BrowserNodeWebviewTag);
  webview.emitContextMenu({ x: 42, y: 77 });
  await Promise.resolve();

  assert.deepEqual(controller.getState().devToolsContextMenu, {
    x: 42,
    y: 77
  });
  assert.deepEqual(openDevToolsCalls, []);
  await controller.openDevToolsFromContextMenu();

  assert.deepEqual(openDevToolsCalls, ["browser-devtools"]);
  assert.equal(controller.getState().devToolsContextMenu, null);
  controller.release();
});

test("Browser Node webview controller delegates devtools context menus to the native host menu when available", async () => {
  const nativeContextMenuCalls: Array<{
    label: string;
    nodeId: string;
    point: { x: number; y: number };
  }> = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      showDevToolsContextMenu(payload) {
        nativeContextMenuCalls.push(payload);
        return Promise.resolve();
      }
    })
  });

  const controller = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "https://example.com/",
    lifecycle: "active",
    nodeId: "browser-native-devtools",
    profileId: null,
    sessionMode: "shared"
  });

  const webview = new MockBrowserNodeWebviewTag(31);
  controller.retain();
  controller.setWebview(webview as unknown as BrowserNodeWebviewTag);
  webview.emitContextMenu({ x: 64, y: 96 });
  await Promise.resolve();

  assert.deepEqual(nativeContextMenuCalls, [
    {
      label: "Open DevTools",
      nodeId: "browser-native-devtools",
      point: { x: 64, y: 96 }
    }
  ]);
  assert.equal(controller.getState().devToolsContextMenu, null);
  controller.release();
});

test("Browser Node webview controller opens devtools after menu dismisses during click", async () => {
  const openDevToolsCalls: string[] = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      openDevTools(payload) {
        openDevToolsCalls.push(payload.nodeId);
        return Promise.resolve();
      }
    })
  });

  const controller = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "https://example.com/",
    lifecycle: "active",
    nodeId: "browser-devtools-dismiss",
    profileId: null,
    sessionMode: "shared"
  });

  const webview = new MockBrowserNodeWebviewTag(29);
  controller.retain();
  controller.setWebview(webview as unknown as BrowserNodeWebviewTag);
  webview.emitContextMenu({ x: 42, y: 77 });
  await Promise.resolve();

  controller.dismissDevToolsContextMenu();
  await controller.openDevToolsFromContextMenu();

  assert.deepEqual(openDevToolsCalls, ["browser-devtools-dismiss"]);
  assert.equal(controller.getState().devToolsContextMenu, null);
  controller.release();
});

function createBrowserNodeHostApi(
  overrides: Partial<BrowserNodeHostApi> = {}
): BrowserNodeHostApi {
  return {
    activate: overrides.activate ?? (() => Promise.resolve()),
    close: overrides.close ?? (() => Promise.resolve()),
    goBack: overrides.goBack ?? (() => Promise.resolve()),
    goForward: overrides.goForward ?? (() => Promise.resolve()),
    navigate: overrides.navigate ?? (() => Promise.resolve()),
    onEvent: overrides.onEvent ?? (() => () => undefined),
    prepareSession: overrides.prepareSession ?? (() => Promise.resolve()),
    registerGuest: overrides.registerGuest ?? (() => Promise.resolve()),
    reload: overrides.reload ?? (() => Promise.resolve()),
    unregisterGuest: overrides.unregisterGuest ?? (() => Promise.resolve()),
    ...(overrides.openDevTools ? { openDevTools: overrides.openDevTools } : {}),
    ...(overrides.showDevToolsContextMenu
      ? { showDevToolsContextMenu: overrides.showDevToolsContextMenu }
      : {}),
    ...(overrides.updateAutomationTarget
      ? { updateAutomationTarget: overrides.updateAutomationTarget }
      : {})
  };
}

class MockBrowserNodeWebviewTag extends EventTarget {
  private readonly webContentsId: number;
  private readonly rect = {
    bottom: 500,
    height: 300,
    left: 100,
    right: 500,
    top: 200,
    width: 400,
    x: 100,
    y: 200,
    toJSON: () => ({})
  };
  throwWhenReadingWebContentsId = false;

  constructor(webContentsId: number) {
    super();
    this.webContentsId = webContentsId;
  }

  getWebContentsId(): number {
    if (this.throwWhenReadingWebContentsId) {
      throw new Error("The WebView must be attached to the DOM");
    }
    return this.webContentsId;
  }

  emit(event: string): void {
    this.dispatchEvent(new Event(event));
  }

  emitContextMenu(point: { x: number; y: number }): void {
    const event = new Event("context-menu", { cancelable: true });
    Object.defineProperties(event, {
      params: { value: point }
    });
    this.dispatchEvent(event);
  }

  emitIpcMessage(channel: string): void {
    const event = new Event("ipc-message");
    Object.defineProperties(event, {
      channel: { value: channel }
    });
    this.dispatchEvent(event);
  }

  getBoundingClientRect(): DOMRect {
    return this.rect;
  }
}
