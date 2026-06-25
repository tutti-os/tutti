import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeFeature } from "./feature.ts";
import { acquireBrowserNodeWebviewController } from "./webviewController.ts";
import type { BrowserNodeHostApi } from "./types.ts";
import type { BrowserNodeWebviewTag } from "../react/webviewTag.ts";

test("Browser Node webview controller prepares sessions when active", async () => {
  const prepareCalls: Array<{ nodeId: string; profileId: string | null }> = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      prepareSession(payload) {
        prepareCalls.push({
          nodeId: payload.nodeId,
          profileId: payload.profileId
        });
        return Promise.resolve();
      }
    })
  });

  const controller = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "https://example.com/",
    lifecycle: "active",
    nodeId: "browser-1",
    profileId: null,
    sessionMode: "shared"
  });

  controller.retain();
  await Promise.resolve();
  assert.deepEqual(prepareCalls, [{ nodeId: "browser-1", profileId: null }]);
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

test("Browser Node webview controller unregisters guests after release", async () => {
  const registerCalls: number[] = [];
  const unregisterCalls: number[] = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      registerGuest(payload) {
        registerCalls.push(payload.webContentsId);
        return Promise.resolve();
      },
      unregisterGuest(payload) {
        unregisterCalls.push(payload.webContentsId);
        return Promise.resolve();
      }
    })
  });

  const controller = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "https://example.com/",
    lifecycle: "active",
    nodeId: "browser-3",
    profileId: null,
    sessionMode: "shared"
  });

  const webview = new MockBrowserNodeWebviewTag(17);
  controller.retain();
  controller.setWebview(webview as unknown as BrowserNodeWebviewTag);
  webview.emit("did-attach");
  await Promise.resolve();
  await Promise.resolve();

  controller.release();
  await new Promise((resolve) => {
    setTimeout(resolve, 300);
  });

  assert.deepEqual(registerCalls, [17]);
  assert.deepEqual(unregisterCalls, [17]);
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

test("Browser Node webview controller keeps a pending guest alive when the node is retained again", async () => {
  const registerCalls: number[] = [];
  const unregisterCalls: number[] = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      registerGuest(payload) {
        registerCalls.push(payload.webContentsId);
        return Promise.resolve();
      },
      unregisterGuest(payload) {
        unregisterCalls.push(payload.webContentsId);
        return Promise.resolve();
      }
    })
  });

  const first = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "https://example.com/",
    lifecycle: "active",
    nodeId: "browser-retained-again",
    profileId: null,
    sessionMode: "shared"
  });

  const webview = new MockBrowserNodeWebviewTag(19);
  first.retain();
  first.setWebview(webview as unknown as BrowserNodeWebviewTag);
  webview.emit("did-attach");
  await Promise.resolve();
  await Promise.resolve();

  first.release();
  const second = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "https://example.com/",
    lifecycle: "active",
    nodeId: "browser-retained-again",
    profileId: null,
    sessionMode: "shared"
  });
  second.retain();

  await waitForTimers();
  assert.deepEqual(registerCalls, [19]);
  assert.deepEqual(unregisterCalls, []);

  second.release();
  await waitForTimers();
  assert.deepEqual(unregisterCalls, [19]);
});

test("Browser Node webview controller keeps shared guest registration alive until the last consumer releases", async () => {
  const registerCalls: number[] = [];
  const unregisterCalls: number[] = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      registerGuest(payload) {
        registerCalls.push(payload.webContentsId);
        return Promise.resolve();
      },
      unregisterGuest(payload) {
        unregisterCalls.push(payload.webContentsId);
        return Promise.resolve();
      }
    })
  });

  const first = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "https://example.com/",
    lifecycle: "active",
    nodeId: "browser-4",
    profileId: null,
    sessionMode: "shared"
  });
  const second = acquireBrowserNodeWebviewController({
    feature,
    initialUrl: "https://example.com/",
    lifecycle: "active",
    nodeId: "browser-4",
    profileId: null,
    sessionMode: "shared"
  });

  const webview = new MockBrowserNodeWebviewTag(21);
  first.retain();
  second.retain();
  first.setWebview(webview as unknown as BrowserNodeWebviewTag);
  webview.emit("did-attach");
  await Promise.resolve();
  await Promise.resolve();

  first.release();
  await waitForTimers();
  assert.deepEqual(unregisterCalls, []);

  second.release();
  await waitForTimers();
  assert.deepEqual(registerCalls, [21]);
  assert.deepEqual(unregisterCalls, [21]);
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

  getBoundingClientRect(): DOMRect {
    return this.rect;
  }
}

function waitForTimers(durationMs = 300): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
