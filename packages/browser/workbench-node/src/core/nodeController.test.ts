import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeFeature } from "./feature.ts";
import { acquireBrowserNodeController } from "./nodeController.ts";
import { createBrowserNodeRuntimeStore } from "./runtimeStore.ts";
import type { BrowserNodeHostApi } from "./types.ts";

test("Browser Node controller derives display and draft URL from runtime state", async () => {
  const runtimeStore = createBrowserNodeRuntimeStore();
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi(),
    runtimeStore
  });
  const controller = acquireBrowserNodeController({
    defaultUrl: "https://example.com/",
    feature,
    nodeId: "browser-1"
  });

  controller.retain();
  assert.equal(controller.getState().displayUrl, "https://example.com/");
  assert.equal(controller.getState().draftUrl, "https://example.com/");

  runtimeStore.applyEvent({
    canGoBack: false,
    canGoForward: false,
    isAttachedToWindow: true,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "browser-1",
    title: "OpenAI",
    type: "state",
    url: "https://openai.com/"
  });

  assert.equal(controller.getState().displayUrl, "https://openai.com/");
  assert.equal(controller.getState().draftUrl, "https://openai.com/");
  controller.release();
});

test("Browser Node controller submits resolved draft URLs through host navigation", async () => {
  const navigateCalls: string[] = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      navigate(payload) {
        navigateCalls.push(payload.url);
        return Promise.resolve();
      }
    })
  });
  const controller = acquireBrowserNodeController({
    defaultUrl: "https://example.com/",
    feature,
    nodeId: "browser-2"
  });

  controller.retain();
  controller.setDraftUrl("openai.com");
  await controller.submitDraftUrl();

  assert.deepEqual(navigateCalls, ["https://openai.com/"]);
  assert.equal(controller.getState().draftUrl, "https://openai.com/");
  controller.release();
});

test("Browser Node controller auto-activates cold nodes from the default URL", async () => {
  const activateCalls: string[] = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      activate(payload) {
        activateCalls.push(payload.url);
        return Promise.resolve();
      }
    })
  });
  const controller = acquireBrowserNodeController({
    defaultUrl: "https://example.com/",
    feature,
    nodeId: "browser-3"
  });

  controller.retain();
  await Promise.resolve();

  assert.deepEqual(activateCalls, ["https://example.com/"]);
  controller.release();
});

test("Browser Node controller does not auto-activate blank default URLs", async () => {
  const activateCalls: string[] = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      activate(payload) {
        activateCalls.push(payload.url);
        return Promise.resolve();
      }
    })
  });
  const controller = acquireBrowserNodeController({
    defaultUrl: "about:blank",
    feature,
    nodeId: "browser-blank"
  });

  controller.retain();
  await Promise.resolve();

  assert.deepEqual(activateCalls, []);
  controller.release();
});

test("Browser Node controller resyncs display state when the default URL changes for the same node", () => {
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi()
  });
  const first = acquireBrowserNodeController({
    defaultUrl: "https://example.com/",
    feature,
    nodeId: "browser-4"
  });

  first.retain();
  assert.equal(first.getState().displayUrl, "https://example.com/");
  assert.equal(first.getState().draftUrl, "https://example.com/");

  const second = acquireBrowserNodeController({
    defaultUrl: "https://openai.com/",
    feature,
    nodeId: "browser-4"
  });

  assert.equal(first, second);
  assert.equal(second.getState().displayUrl, "https://openai.com/");
  assert.equal(second.getState().draftUrl, "https://openai.com/");
  second.release();
});

test("Browser Node controller syncs active nodes to changed default URLs when requested", async () => {
  const activateCalls: string[] = [];
  const runtimeStore = createBrowserNodeRuntimeStore();
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      activate(payload) {
        activateCalls.push(payload.url);
        return Promise.resolve();
      }
    }),
    runtimeStore
  });
  runtimeStore.applyEvent({
    canGoBack: false,
    canGoForward: false,
    isAttachedToWindow: true,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "app-1",
    title: null,
    type: "state",
    url: "http://127.0.0.1:55890/"
  });
  runtimeStore.applyEvent({
    code: "navigation-failed",
    diagnosticMessage: "ERR_CONNECTION_REFUSED",
    nodeId: "app-1",
    type: "error"
  });

  const controller = acquireBrowserNodeController({
    defaultUrl: "http://127.0.0.1:56632/",
    feature,
    nodeId: "app-1",
    syncDefaultUrl: true
  });

  controller.retain();
  await Promise.resolve();

  assert.deepEqual(activateCalls, ["http://127.0.0.1:56632/"]);
  controller.release();
});

test("Browser Node controller syncs retained nodes after default URL prop changes", async () => {
  const activateCalls: string[] = [];
  const runtimeStore = createBrowserNodeRuntimeStore();
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      activate(payload) {
        activateCalls.push(payload.url);
        return Promise.resolve();
      }
    }),
    runtimeStore
  });
  runtimeStore.applyEvent({
    canGoBack: false,
    canGoForward: false,
    isAttachedToWindow: true,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "app-2",
    title: null,
    type: "state",
    url: "http://127.0.0.1:55890/"
  });
  runtimeStore.applyEvent({
    code: "navigation-failed",
    diagnosticMessage: "ERR_CONNECTION_REFUSED",
    nodeId: "app-2",
    type: "error"
  });

  const first = acquireBrowserNodeController({
    defaultUrl: "http://127.0.0.1:55890/",
    feature,
    nodeId: "app-2",
    syncDefaultUrl: true
  });
  first.retain();
  await Promise.resolve();
  assert.deepEqual(activateCalls, ["http://127.0.0.1:55890/"]);

  const second = acquireBrowserNodeController({
    defaultUrl: "http://127.0.0.1:56632/",
    feature,
    nodeId: "app-2",
    syncDefaultUrl: true
  });

  assert.equal(first, second);
  assert.deepEqual(activateCalls, ["http://127.0.0.1:55890/"]);
  second.sync();
  await Promise.resolve();

  assert.deepEqual(activateCalls, [
    "http://127.0.0.1:55890/",
    "http://127.0.0.1:56632/"
  ]);
  second.release();
});

test("Browser Node controller preserves same-origin in-app navigation after attaching to an active default URL", async () => {
  const activateCalls: string[] = [];
  const runtimeStore = createBrowserNodeRuntimeStore();
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      activate(payload) {
        activateCalls.push(payload.url);
        return Promise.resolve();
      }
    }),
    runtimeStore
  });
  runtimeStore.applyEvent({
    canGoBack: false,
    canGoForward: false,
    isAttachedToWindow: true,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "app-route",
    title: null,
    type: "state",
    url: "http://127.0.0.1:55890/"
  });

  const controller = acquireBrowserNodeController({
    defaultUrl: "http://127.0.0.1:55890/",
    feature,
    nodeId: "app-route",
    syncDefaultUrl: true
  });

  controller.retain();
  await Promise.resolve();
  assert.deepEqual(activateCalls, []);

  runtimeStore.applyEvent({
    canGoBack: true,
    canGoForward: false,
    isAttachedToWindow: true,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "app-route",
    title: "Project",
    type: "state",
    url: "http://127.0.0.1:55890/project/project-1"
  });
  await Promise.resolve();

  assert.deepEqual(activateCalls, []);
  controller.release();
});

test("Browser Node controller does not fight same-origin auth redirects when default URL follows runtime", async () => {
  const activateCalls: string[] = [];
  const runtimeStore = createBrowserNodeRuntimeStore();
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      activate(payload) {
        activateCalls.push(payload.url);
        return Promise.resolve();
      }
    }),
    runtimeStore
  });
  runtimeStore.applyEvent({
    canGoBack: false,
    canGoForward: false,
    isAttachedToWindow: true,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "auth-redirect",
    title: null,
    type: "state",
    url: "https://app.example/"
  });

  const controller = acquireBrowserNodeController({
    defaultUrl: "https://app.example/",
    feature,
    nodeId: "auth-redirect",
    syncDefaultUrl: true
  });
  controller.retain();
  await Promise.resolve();
  assert.deepEqual(activateCalls, []);

  // Guest redirected to /dashboard; host defaultUrl catches up to the runtime page.
  runtimeStore.applyEvent({
    canGoBack: true,
    canGoForward: false,
    isAttachedToWindow: true,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "auth-redirect",
    title: "Dashboard",
    type: "state",
    url: "https://app.example/dashboard"
  });
  acquireBrowserNodeController({
    defaultUrl: "https://app.example/dashboard",
    feature,
    nodeId: "auth-redirect",
    syncDefaultUrl: true
  }).sync();
  await Promise.resolve();
  assert.deepEqual(activateCalls, []);

  // Redirect chain still in flight: committed /dashboard while guest is briefly on /.
  runtimeStore.applyEvent({
    canGoBack: false,
    canGoForward: false,
    isAttachedToWindow: true,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "auth-redirect",
    title: null,
    type: "state",
    url: "https://app.example/"
  });
  acquireBrowserNodeController({
    defaultUrl: "https://app.example/dashboard",
    feature,
    nodeId: "auth-redirect",
    syncDefaultUrl: true
  }).sync();
  await Promise.resolve();
  assert.deepEqual(activateCalls, []);

  // Cross-origin host URL changes must still force navigation.
  acquireBrowserNodeController({
    defaultUrl: "https://example.com/",
    feature,
    nodeId: "auth-redirect",
    syncDefaultUrl: true
  }).sync();
  await Promise.resolve();
  assert.deepEqual(activateCalls, ["https://example.com/"]);
  controller.release();
});

test("Browser Node controller shares retain lifecycle across consumers of the same node", () => {
  let connectCount = 0;
  let disconnectCount = 0;
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      onEvent() {
        connectCount += 1;
        return () => {
          disconnectCount += 1;
        };
      }
    })
  });

  const first = acquireBrowserNodeController({
    defaultUrl: "https://example.com/",
    feature,
    nodeId: "browser-5"
  });
  const second = acquireBrowserNodeController({
    defaultUrl: "https://example.com/",
    feature,
    nodeId: "browser-5"
  });

  first.retain();
  second.retain();
  assert.equal(connectCount, 1);

  first.release();
  assert.equal(disconnectCount, 0);

  second.release();
  assert.equal(disconnectCount, 1);
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
    unregisterGuest: overrides.unregisterGuest ?? (() => Promise.resolve())
  };
}
