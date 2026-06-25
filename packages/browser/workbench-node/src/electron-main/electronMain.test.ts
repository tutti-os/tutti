import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  enforceBrowserWebviewSecurity,
  installBrowserWebviewSecurity,
  isBrowserNodeWebviewAttach,
  registerBrowserNodeElectronMain,
  sanitizeBrowserGuestUserAgent
} from "./index.ts";
import { createBrowserGuestManager } from "./guestManager.ts";
import type {
  BrowserGuestNativeImage,
  BrowserGuestWebContents,
  BrowserGuestWindowOpenHandlerResponse
} from "./types.ts";
import type { BrowserNodeEvent } from "../core/types.ts";

type InstallBrowserWebviewSecurityInput = Parameters<
  typeof installBrowserWebviewSecurity
>[0];

test("enforces Browser Node webview security policy", () => {
  const webPreferences: Record<string, unknown> = {
    contextIsolation: false,
    nodeIntegration: true,
    preload: "/tmp/unsafe.js",
    sandbox: false,
    webSecurity: false
  };
  const params = {
    partition: "persist:browser-node-shared",
    src: "example.com"
  };

  assert.deepEqual(
    enforceBrowserWebviewSecurity({
      params,
      webPreferences
    }),
    { allowed: true, reason: null }
  );
  assert.equal(params.src, "https://example.com/");
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.nodeIntegrationInSubFrames, false);
  assert.equal(webPreferences.preload, undefined);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.webSecurity, true);

  assert.equal(
    enforceBrowserWebviewSecurity({
      params: {
        "data-browser-node-webview": "true",
        partition: "persist:default",
        src: "https://example.com/"
      },
      webPreferences: {}
    }).allowed,
    false
  );
  assert.equal(
    enforceBrowserWebviewSecurity({
      params: {
        src: "https://example.com/"
      },
      webPreferences: {}
    }).allowed,
    false
  );
});

test("allows blank Browser Node webview attachments for controlled loading", () => {
  const params = {
    partition: "persist:browser-node-shared",
    src: "about:blank"
  };

  assert.deepEqual(
    enforceBrowserWebviewSecurity({
      params,
      webPreferences: {}
    }),
    { allowed: true, reason: null }
  );
  assert.equal(params.src, "about:blank");
});

test("applies host-controlled Browser Node guest preload after validation", () => {
  const webPreferences: Record<string, unknown> = {
    preload: "/tmp/guest-controlled.js"
  };
  const params = {
    partition: "persist:browser-node-shared",
    src: "example.com"
  };
  let resolvedSrc = "";

  assert.deepEqual(
    enforceBrowserWebviewSecurity({
      params,
      resolvePreload: ({ params: resolvedParams }) => {
        resolvedSrc = resolvedParams.src ?? "";
        return " /tmp/host-browser-guest-preload.js ";
      },
      webPreferences
    }),
    { allowed: true, reason: null }
  );

  assert.equal(resolvedSrc, "https://example.com/");
  assert.equal(webPreferences.nodeIntegrationInSubFrames, true);
  assert.equal(webPreferences.preload, "/tmp/host-browser-guest-preload.js");

  let invalidResolverCalls = 0;
  const invalidWebPreferences: Record<string, unknown> = {
    preload: "/tmp/guest-controlled-invalid.js"
  };

  assert.equal(
    enforceBrowserWebviewSecurity({
      params: {
        partition: "persist:default",
        src: "https://example.com/"
      },
      resolvePreload: () => {
        invalidResolverCalls += 1;
        return "/tmp/host-browser-guest-preload.js";
      },
      webPreferences: invalidWebPreferences
    }).allowed,
    false
  );
  assert.equal(invalidResolverCalls, 0);
  assert.equal(invalidWebPreferences.preload, undefined);
});

test("matches Browser Node webview attachments without handling unrelated webviews", () => {
  assert.equal(
    isBrowserNodeWebviewAttach({
      partition: "persist:browser-node-shared",
      src: "https://example.com/"
    }),
    true
  );
  assert.equal(
    isBrowserNodeWebviewAttach({
      "data-browser-node-webview": "true",
      partition: "persist:default",
      src: "https://example.com/"
    }),
    true
  );
  assert.equal(
    isBrowserNodeWebviewAttach({
      partition: "persist:default",
      src: "https://example.com/"
    }),
    false
  );
  assert.equal(
    isBrowserNodeWebviewAttach(
      {
        partition: "persist:tutti-app:workspace:hello",
        src: "http://127.0.0.1:4100/"
      },
      {
        additionalAllowedPrefixes: ["persist:tutti-app:"]
      }
    ),
    true
  );
});

test("ignores non-Browser Node webviews when installing owner security hooks", () => {
  const contents = new EventEmitter();
  const webPreferences: Record<string, unknown> = {
    contextIsolation: false,
    preload: "/tmp/other-webview.js"
  };
  const params = {
    partition: "persist:default",
    src: "https://example.com/"
  };
  let didPreventDefault = false;
  let guestAttachedCount = 0;
  let setWindowOpenHandlerCount = 0;
  const cleanup = installBrowserWebviewSecurity({
    contents:
      contents as unknown as InstallBrowserWebviewSecurityInput["contents"],
    onGuestAttached: () => {
      guestAttachedCount += 1;
    },
    openExternal: () => undefined
  });

  contents.emit(
    "will-attach-webview",
    {
      preventDefault() {
        didPreventDefault = true;
      }
    },
    webPreferences,
    params
  );
  contents.emit(
    "did-attach-webview",
    {},
    {
      setWindowOpenHandler() {
        setWindowOpenHandlerCount += 1;
      }
    }
  );

  cleanup();

  assert.equal(didPreventDefault, false);
  assert.equal(guestAttachedCount, 0);
  assert.equal(setWindowOpenHandlerCount, 0);
  assert.equal(webPreferences.preload, "/tmp/other-webview.js");
});

test("handles additional allowed Browser Node webview partitions", () => {
  const contents = new EventEmitter();
  const webPreferences: Record<string, unknown> = {};
  const params: Record<string, string> = {
    partition: "persist:tutti-app:workspace:hello",
    src: "http://127.0.0.1:4100/"
  };
  let guestAttachedId: number | null = null;
  let setWindowOpenHandlerCount = 0;
  const cleanup = installBrowserWebviewSecurity({
    allowedSessionPartitions: {
      additionalAllowedPrefixes: ["persist:tutti-app:"]
    },
    contents:
      contents as unknown as InstallBrowserWebviewSecurityInput["contents"],
    onGuestAttached: (guestContents) => {
      guestAttachedId = guestContents.id ?? null;
    },
    openExternal: () => undefined
  });

  contents.emit(
    "will-attach-webview",
    {
      preventDefault() {
        throw new Error("webview should not be blocked");
      }
    },
    webPreferences,
    params
  );
  contents.emit(
    "did-attach-webview",
    {},
    {
      id: 41,
      setWindowOpenHandler() {
        setWindowOpenHandlerCount += 1;
      }
    }
  );

  cleanup();

  assert.equal(guestAttachedId, 41);
  assert.equal(setWindowOpenHandlerCount, 1);
  assert.equal(params.allowpopups, undefined);
  assert.equal(params.src, "http://127.0.0.1:4100/");
});

test("externalizes popup windows before Browser Node guests register", () => {
  const contents = new EventEmitter();
  const webPreferences: Record<string, unknown> = {};
  const params: Record<string, string> = {
    partition: "persist:browser-node-shared",
    src: "about:blank"
  };
  type WindowOpenHandler = (details: {
    url: string;
  }) => BrowserGuestWindowOpenHandlerResponse;
  const captured: { windowOpenHandler?: WindowOpenHandler } = {};
  let externallyOpenedUrl: string | null = null;
  const cleanup = installBrowserWebviewSecurity({
    contents:
      contents as unknown as InstallBrowserWebviewSecurityInput["contents"],
    openExternal: (url) => {
      externallyOpenedUrl = url;
    }
  });

  contents.emit(
    "will-attach-webview",
    {
      preventDefault() {
        throw new Error("webview should not be blocked");
      }
    },
    webPreferences,
    params
  );
  contents.emit(
    "did-attach-webview",
    {},
    {
      id: 42,
      setWindowOpenHandler(handler: WindowOpenHandler) {
        captured.windowOpenHandler = handler;
      }
    }
  );

  cleanup();

  if (!captured.windowOpenHandler) {
    throw new Error("expected a window-open handler to be installed");
  }

  assert.deepEqual(
    captured.windowOpenHandler({ url: "https://example.com/popup" }),
    { action: "deny" }
  );
  assert.equal(externallyOpenedUrl, "https://example.com/popup");
  assert.equal(params.allowpopups, "true");
});

test("allows attached guests to override the default window-open handler", () => {
  const contents = new EventEmitter();
  const webPreferences: Record<string, unknown> = {};
  const params = {
    partition: "persist:tutti-app:workspace:hello",
    src: "http://127.0.0.1:4100/"
  };
  type WindowOpenHandler = (details: {
    url: string;
  }) => BrowserGuestWindowOpenHandlerResponse;
  const captured: { windowOpenHandler?: WindowOpenHandler } = {};
  let customOpenedUrl: string | null = null;
  let externallyOpenedUrl: string | null = null;
  const cleanup = installBrowserWebviewSecurity({
    allowedSessionPartitions: {
      additionalAllowedPrefixes: ["persist:tutti-app:"]
    },
    contents:
      contents as unknown as InstallBrowserWebviewSecurityInput["contents"],
    onGuestAttached: (guestContents) => {
      guestContents.setWindowOpenHandler?.(({ url }) => {
        customOpenedUrl = url;
        return { action: "deny" };
      });
    },
    openExternal: (url) => {
      externallyOpenedUrl = url;
    }
  });

  contents.emit(
    "will-attach-webview",
    {
      preventDefault() {
        throw new Error("webview should not be blocked");
      }
    },
    webPreferences,
    params
  );
  contents.emit(
    "did-attach-webview",
    {},
    {
      id: 42,
      setWindowOpenHandler(handler: WindowOpenHandler) {
        captured.windowOpenHandler = handler;
      }
    }
  );

  cleanup();

  if (!captured.windowOpenHandler) {
    throw new Error("expected a window-open handler to be installed");
  }

  assert.deepEqual(
    captured.windowOpenHandler({ url: "https://example.com/" }),
    {
      action: "deny"
    }
  );
  assert.equal(customOpenedUrl, "https://example.com/");
  assert.equal(externallyOpenedUrl, null);
});

test("sanitizes Electron token from Browser Node guest user agents", () => {
  assert.equal(
    sanitizeBrowserGuestUserAgent(
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/134.0.0.0 Electron/35.7.5 Safari/537.36"
    ),
    "Mozilla/5.0 AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36"
  );
});

test("applies sanitized user agent when Browser Node webviews attach", () => {
  const contents = new EventEmitter();
  const webPreferences: Record<string, unknown> = {};
  const params = {
    partition: "persist:browser-node-shared",
    src: "about:blank"
  };
  let userAgent =
    "Mozilla/5.0 AppleWebKit/537.36 Chrome/134.0.0.0 Electron/35.7.5 Safari/537.36";
  const cleanup = installBrowserWebviewSecurity({
    contents:
      contents as unknown as InstallBrowserWebviewSecurityInput["contents"],
    openExternal: () => undefined
  });

  contents.emit(
    "will-attach-webview",
    {
      preventDefault() {
        throw new Error("webview should not be blocked");
      }
    },
    webPreferences,
    params
  );
  contents.emit(
    "did-attach-webview",
    {},
    {
      getUserAgent() {
        return userAgent;
      },
      setUserAgent(nextUserAgent: string) {
        userAgent = nextUserAgent;
      },
      setWindowOpenHandler() {}
    }
  );

  cleanup();

  assert.equal(
    userAgent,
    "Mozilla/5.0 AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36"
  );
});

test("manages Browser Node guest lifecycle with mocked web contents", async () => {
  const events: BrowserNodeEvent[] = [];
  const contents = new MockBrowserGuestWebContents(7);
  const manager = createBrowserGuestManager({
    emit: (event) => events.push(event),
    openExternal: () => undefined,
    resolveWebContents: (id) => (id === contents.id ? contents : null)
  });

  await manager.prepareSession({
    nodeId: "browser-1",
    profileId: null,
    sessionMode: "shared"
  });
  await manager.activate({
    nodeId: "browser-1",
    profileId: null,
    sessionMode: "shared",
    url: "example.com"
  });
  await manager.registerGuest({
    nodeId: "browser-1",
    profileId: null,
    sessionMode: "shared",
    webContentsId: 7
  });

  assert.equal(contents.loadedUrls.at(-1), "https://example.com/");
  assert.equal(manager.debugDump({ nodeId: "browser-1" })?.webContentsId, 7);
  assert.equal(
    manager.debugDump({ nodeId: "browser-1" })?.userAgent,
    "MockBrowser/1.0"
  );
  assert.equal(
    await manager.capturePreview({ nodeId: "browser-1" }),
    "data:image/png;base64,browser-preview"
  );

  contents.canGoBackValue = true;
  await manager.goBack({ nodeId: "browser-1" });
  assert.equal(contents.backCalls, 1);

  await manager.unregisterGuest({ nodeId: "browser-1", webContentsId: 7 });
  assert.equal(manager.debugDump({ nodeId: "browser-1" })?.lifecycle, "cold");
  await manager.close({ nodeId: "browser-1" });
  assert.equal(manager.debugDump({ nodeId: "browser-1" }), null);
  assert.equal(events.at(-1)?.type, "closed");
  assert.equal(
    events.some((event) => event.type === "state"),
    true
  );
});

test("opens Browser Node guest devtools for a registered node", async () => {
  const contents = new MockBrowserGuestWebContents(15);
  const manager = createBrowserGuestManager({
    emit: () => undefined,
    openExternal: () => undefined,
    resolveWebContents: (id) => (id === contents.id ? contents : null)
  });

  await manager.registerGuest({
    nodeId: "browser-devtools",
    profileId: null,
    sessionMode: "shared",
    webContentsId: 15
  });

  await manager.openDevTools({ nodeId: "browser-devtools" });
  await manager.openDevTools({ nodeId: "missing-node" });

  assert.equal(contents.openDevToolsCalls, 1);
  assert.deepEqual(contents.openDevToolsOptions, [
    { activate: true, mode: "detach" }
  ]);
});

test("blocks cross-origin Browser Node guest navigation for policy-bound sessions", async () => {
  const contents = new MockBrowserGuestWebContents(11);
  const events: BrowserNodeEvent[] = [];
  const openedExternalUrls: string[] = [];
  const navigationPolicy = {
    mode: "same-origin" as const,
    originUrl: "http://127.0.0.1:4100/"
  };
  const manager = createBrowserGuestManager({
    emit: (event) => events.push(event),
    openExternal: (url) => {
      openedExternalUrls.push(url);
    },
    resolveWebContents: (id) => (id === contents.id ? contents : null)
  });

  await manager.activate({
    navigationPolicy,
    nodeId: "app-1",
    profileId: null,
    sessionMode: "shared",
    url: "http://127.0.0.1:4100/"
  });
  await manager.registerGuest({
    navigationPolicy,
    nodeId: "app-1",
    profileId: null,
    sessionMode: "shared",
    webContentsId: 11
  });

  let sameOriginPrevented = false;
  contents.emit(
    "will-navigate",
    {
      preventDefault() {
        sameOriginPrevented = true;
      }
    },
    "http://127.0.0.1:4100/settings"
  );

  let crossOriginPrevented = false;
  contents.emit(
    "will-navigate",
    {
      preventDefault() {
        crossOriginPrevented = true;
      }
    },
    "https://example.com/docs"
  );
  await Promise.resolve();

  assert.equal(sameOriginPrevented, false);
  assert.equal(crossOriginPrevented, true);
  assert.deepEqual(openedExternalUrls, []);
  assert.deepEqual(
    events.filter((event) => event.type === "open-url"),
    [
      {
        reuseIfOpen: true,
        sourceNodeId: "app-1",
        type: "open-url",
        url: "https://example.com/docs"
      }
    ]
  );
});

test("opens Browser Node URLs externally after validation", async () => {
  const openedExternalUrls: string[] = [];
  const manager = createBrowserGuestManager({
    emit: () => undefined,
    openExternal: (url) => {
      openedExternalUrls.push(url);
    },
    resolveWebContents: () => null
  });

  await manager.openExternal({ url: "example.com/docs" });

  assert.deepEqual(openedExternalUrls, ["https://example.com/docs"]);
  await manager.openExternal({ url: "file:///tmp/local.html" });
  assert.deepEqual(openedExternalUrls, [
    "https://example.com/docs",
    "file:///tmp/local.html"
  ]);
});

test("converts guest preload open-url requests into Browser Node open-url events", async () => {
  const events: BrowserNodeEvent[] = [];
  const openedExternalUrls: string[] = [];
  const contents = new MockBrowserGuestWebContents(12);
  const manager = createBrowserGuestManager({
    emit: (event) => events.push(event),
    openExternal: (url) => {
      openedExternalUrls.push(url);
    },
    resolveWebContents: (id) => (id === contents.id ? contents : null)
  });

  await manager.registerGuest({
    nodeId: "browser-target-blank",
    profileId: null,
    sessionMode: "shared",
    webContentsId: 12
  });

  manager.handleGuestOpenUrl(12, {
    url: "https://example.com/popup"
  });

  assert.deepEqual(openedExternalUrls, []);
  assert.deepEqual(
    events.filter((event) => event.type === "open-url"),
    [
      {
        reuseIfOpen: true,
        sourceNodeId: "browser-target-blank",
        type: "open-url",
        url: "https://example.com/popup"
      }
    ]
  );
});

test("keeps Google GIS OAuth popups native while routing ordinary popups through open-url", async () => {
  const events: BrowserNodeEvent[] = [];
  const contents = new MockBrowserGuestWebContents(21);
  const manager = createBrowserGuestManager({
    emit: (event) => events.push(event),
    openExternal: () => undefined,
    resolveWebContents: (id) => (id === contents.id ? contents : null)
  });

  await manager.registerGuest({
    nodeId: "browser-google-oauth",
    profileId: null,
    sessionMode: "shared",
    webContentsId: 21
  });

  if (!contents.windowOpenHandler) {
    throw new Error("expected a window-open handler to be installed");
  }

  assert.deepEqual(
    contents.windowOpenHandler({
      url: "https://example.com/popup"
    }),
    { action: "deny" }
  );
  assert.deepEqual(
    contents.windowOpenHandler({
      url: "https://accounts.google.com/o/oauth2/v2/auth?gsiwebsdk=gis_attributes&client_id=test&redirect_uri=gis_transform&display=popup&response_mode=form_post"
    }),
    { action: "allow" }
  );
  assert.deepEqual(
    events.filter((event) => event.type === "open-url"),
    [
      {
        reuseIfOpen: true,
        sourceNodeId: "browser-google-oauth",
        type: "open-url",
        url: "https://example.com/popup"
      }
    ]
  );
});

test("registerBrowserNodeElectronMain routes guest open-url IPC through the owner manager", async () => {
  const contents = new MockBrowserGuestWebContents(14);
  const handlers = new Map<
    string,
    (event: unknown, payload: unknown) => unknown
  >();
  const listeners = new Map<
    string,
    (event: unknown, payload: unknown) => void
  >();
  const sentEvents: BrowserNodeEvent[] = [];
  const ownerWindow = {
    isDestroyed: () => false,
    once: () => undefined,
    webContents: {
      send(_channel: string, event: BrowserNodeEvent) {
        sentEvents.push(event);
      }
    }
  };

  registerBrowserNodeElectronMain({
    channels: {
      activate: "browser:activate",
      close: "browser:close",
      event: "browser:event",
      goBack: "browser:goBack",
      goForward: "browser:goForward",
      guestOpenUrl: "browser:guestOpenUrl",
      navigate: "browser:navigate",
      prepareSession: "browser:prepareSession",
      registerGuest: "browser:registerGuest",
      reload: "browser:reload",
      unregisterGuest: "browser:unregisterGuest"
    },
    getOwnerWindow: () => ownerWindow as never,
    openExternal: () => undefined,
    registerHandler(channel, handler) {
      handlers.set(channel, handler as never);
    },
    registerListener(channel, handler) {
      listeners.set(channel, handler as never);
    },
    resolveWebContents: ({ webContentsId }) =>
      webContentsId === contents.id ? contents : null
  });

  await handlers.get("browser:registerGuest")?.(
    {},
    {
      nodeId: "browser-ipc-open-url",
      profileId: null,
      sessionMode: "shared",
      webContentsId: 14
    }
  );
  listeners.get("browser:guestOpenUrl")?.(
    { sender: { id: 14 } },
    { url: "https://example.com/from-preload" }
  );

  assert.deepEqual(
    sentEvents.filter((event) => event.type === "open-url"),
    [
      {
        reuseIfOpen: true,
        sourceNodeId: "browser-ipc-open-url",
        type: "open-url",
        url: "https://example.com/from-preload"
      }
    ]
  );
});

test("registerBrowserNodeElectronMain routes open devtools IPC through the owner manager", async () => {
  const contents = new MockBrowserGuestWebContents(16);
  const handlers = new Map<
    string,
    (event: unknown, payload: unknown) => unknown
  >();
  const ownerWindow = {
    isDestroyed: () => false,
    once: () => undefined,
    webContents: {
      send() {}
    }
  };

  registerBrowserNodeElectronMain({
    channels: {
      activate: "browser:activate",
      close: "browser:close",
      event: "browser:event",
      goBack: "browser:goBack",
      goForward: "browser:goForward",
      guestOpenUrl: "browser:guestOpenUrl",
      navigate: "browser:navigate",
      openDevTools: "browser:openDevTools",
      prepareSession: "browser:prepareSession",
      registerGuest: "browser:registerGuest",
      reload: "browser:reload",
      unregisterGuest: "browser:unregisterGuest"
    },
    getOwnerWindow: () => ownerWindow as never,
    openExternal: () => undefined,
    registerHandler(channel, handler) {
      handlers.set(channel, handler as never);
    },
    resolveWebContents: ({ webContentsId }) =>
      webContentsId === contents.id ? contents : null
  });

  await handlers.get("browser:registerGuest")?.(
    {},
    {
      nodeId: "browser-ipc-devtools",
      profileId: null,
      sessionMode: "shared",
      webContentsId: 16
    }
  );
  await handlers.get("browser:openDevTools")?.(
    {},
    { nodeId: "browser-ipc-devtools" }
  );

  assert.equal(contents.openDevToolsCalls, 1);
});

test("registerBrowserNodeElectronMain opens devtools from a native context menu action", async () => {
  const contents = new MockBrowserGuestWebContents(17);
  const handlers = new Map<
    string,
    (event: unknown, payload: unknown) => unknown
  >();
  const nativeMenuRequests: Array<{
    label: string;
    openDevTools: () => Promise<void> | void;
    point: { x: number; y: number };
  }> = [];
  const ownerWindow = {
    isDestroyed: () => false,
    once: () => undefined,
    webContents: {
      send() {}
    }
  };

  registerBrowserNodeElectronMain({
    channels: {
      activate: "browser:activate",
      close: "browser:close",
      event: "browser:event",
      goBack: "browser:goBack",
      goForward: "browser:goForward",
      guestOpenUrl: "browser:guestOpenUrl",
      navigate: "browser:navigate",
      openDevTools: "browser:openDevTools",
      prepareSession: "browser:prepareSession",
      registerGuest: "browser:registerGuest",
      reload: "browser:reload",
      showDevToolsContextMenu: "browser:showDevToolsContextMenu",
      unregisterGuest: "browser:unregisterGuest"
    },
    getOwnerWindow: () => ownerWindow as never,
    openExternal: () => undefined,
    registerHandler(channel, handler) {
      handlers.set(channel, handler as never);
    },
    resolveWebContents: ({ webContentsId }) =>
      webContentsId === contents.id ? contents : null,
    showDevToolsContextMenu(input) {
      nativeMenuRequests.push({
        label: input.label,
        openDevTools: input.openDevTools,
        point: input.point
      });
    }
  });

  await handlers.get("browser:registerGuest")?.(
    {},
    {
      nodeId: "browser-native-menu-devtools",
      profileId: null,
      sessionMode: "shared",
      webContentsId: 17
    }
  );
  await handlers.get("browser:showDevToolsContextMenu")?.(
    {},
    {
      label: "Open DevTools",
      nodeId: "browser-native-menu-devtools",
      point: { x: 10, y: 20 }
    }
  );

  assert.equal(contents.openDevToolsCalls, 0);
  assert.equal(nativeMenuRequests.length, 1);
  assert.deepEqual(nativeMenuRequests[0]?.point, { x: 10, y: 20 });
  assert.equal(nativeMenuRequests[0]?.label, "Open DevTools");

  await nativeMenuRequests[0]?.openDevTools();

  assert.equal(contents.openDevToolsCalls, 1);
});

test("syncs the preferred color scheme to Browser Node guests", async () => {
  const contents = new MockBrowserGuestWebContents(10);
  let currentScheme: "dark" | "light" = "dark";
  let themeListener: ((scheme: "dark" | "light") => void) | null = null;
  let unsubscribeCalls = 0;
  const syncedSchemes: Array<{
    contentsID: number;
    scheme: "dark" | "light";
  }> = [];
  const manager = createBrowserGuestManager({
    emit: () => undefined,
    getPreferredColorScheme: () => currentScheme,
    openExternal: () => undefined,
    resolveWebContents: (id) => (id === contents.id ? contents : null),
    syncPreferredColorScheme(nextContents, scheme) {
      syncedSchemes.push({
        contentsID: nextContents.id ?? -1,
        scheme
      });
    },
    subscribePreferredColorScheme(listener) {
      themeListener = listener;
      return () => {
        unsubscribeCalls += 1;
        themeListener = null;
      };
    }
  });

  await manager.registerGuest({
    nodeId: "browser-1",
    profileId: null,
    sessionMode: "shared",
    webContentsId: 10
  });

  assert.deepEqual(syncedSchemes, [
    {
      contentsID: 10,
      scheme: "dark"
    }
  ]);

  currentScheme = "light";
  assert.ok(themeListener);
  const emitPreferredColorScheme = themeListener as (
    scheme: "dark" | "light"
  ) => void;
  emitPreferredColorScheme("light");
  await Promise.resolve();

  assert.deepEqual(syncedSchemes.at(-1), {
    contentsID: 10,
    scheme: "light"
  });

  manager.dispose();
  assert.equal(unsubscribeCalls, 1);
  assert.equal(themeListener, null);
});

test("ignores aborted Browser Node guest navigations", async () => {
  const events: BrowserNodeEvent[] = [];
  const contents = new MockBrowserGuestWebContents(8);
  const manager = createBrowserGuestManager({
    emit: (event) => events.push(event),
    openExternal: () => undefined,
    resolveWebContents: (id) => (id === contents.id ? contents : null)
  });

  await manager.activate({
    nodeId: "browser-1",
    profileId: null,
    sessionMode: "shared",
    url: "https://example.com/"
  });
  await manager.registerGuest({
    nodeId: "browser-1",
    profileId: null,
    sessionMode: "shared",
    webContentsId: 8
  });
  events.length = 0;

  contents.emit(
    "did-fail-load",
    {},
    -3,
    "ERR_ABORTED",
    "https://example.com/",
    true
  );

  assert.equal(
    events.some((event) => event.type === "error"),
    false
  );
  assert.equal(
    events.some((event) => event.type === "state"),
    true
  );
});

test("reports Browser Node guest HTTP error navigations", async () => {
  const events: BrowserNodeEvent[] = [];
  const contents = new MockBrowserGuestWebContents(18);
  const manager = createBrowserGuestManager({
    emit: (event) => events.push(event),
    openExternal: () => undefined,
    resolveWebContents: (id) => (id === contents.id ? contents : null)
  });

  await manager.registerGuest({
    nodeId: "browser-http-error",
    profileId: null,
    sessionMode: "shared",
    webContentsId: 18
  });
  events.length = 0;

  contents.currentUrl = "https://example.com/missing";
  contents.emit(
    "did-navigate",
    {},
    "https://example.com/missing",
    404,
    "Not Found"
  );

  assert.deepEqual(
    events.filter((event) => event.type === "error"),
    [
      {
        code: "navigation-failed",
        diagnosticMessage: "Not Found",
        nodeId: "browser-http-error",
        params: {
          statusCode: 404,
          statusText: "Not Found"
        },
        type: "error"
      }
    ]
  );
  assert.equal(
    events.some((event) => event.type === "state"),
    true
  );
});

test("keeps Browser Node navigation failures as the final emitted event", async () => {
  const events: BrowserNodeEvent[] = [];
  const contents = new MockBrowserGuestWebContents(19);
  const manager = createBrowserGuestManager({
    emit: (event) => events.push(event),
    openExternal: () => undefined,
    resolveWebContents: (id) => (id === contents.id ? contents : null)
  });

  await manager.registerGuest({
    nodeId: "browser-load-failure",
    profileId: null,
    sessionMode: "shared",
    webContentsId: 19
  });
  events.length = 0;
  contents.loadURL = async (url: string): Promise<void> => {
    contents.currentUrl = url;
    contents.loading = true;
    throw new Error("ERR_CONNECTION_REFUSED");
  };

  await manager.navigate({
    nodeId: "browser-load-failure",
    url: "http://127.0.0.1:3000/"
  });

  assert.equal(events.at(-1)?.type, "error");
  assert.deepEqual(events.at(-1), {
    code: "navigation-failed",
    diagnosticMessage: "ERR_CONNECTION_REFUSED",
    nodeId: "browser-load-failure",
    params: undefined,
    type: "error"
  });
  assert.equal(
    events.some((event) => event.type === "state"),
    true
  );
});

test("uses registerGuest URL before loading a newly attached guest", async () => {
  const contents = new MockBrowserGuestWebContents(21);
  const manager = createBrowserGuestManager({
    emit: () => undefined,
    openExternal: () => undefined,
    resolveWebContents: (id) => (id === contents.id ? contents : null)
  });

  await manager.prepareSession({
    nodeId: "browser-stale-desired",
    profileId: null,
    sessionMode: "shared",
    url: "http://127.0.0.1:50158/"
  });

  await manager.registerGuest({
    nodeId: "browser-stale-desired",
    profileId: null,
    sessionMode: "shared",
    url: "http://127.0.0.1:51103/",
    webContentsId: 21
  });

  assert.deepEqual(contents.loadedUrls, ["http://127.0.0.1:51103/"]);
  assert.equal(
    manager.debugDump({ nodeId: "browser-stale-desired" })?.desiredUrl,
    "http://127.0.0.1:51103/"
  );
});

test("deduplicates Browser Node did-fail-load and loadURL rejection errors", async () => {
  const events: BrowserNodeEvent[] = [];
  const contents = new MockBrowserGuestWebContents(20);
  const manager = createBrowserGuestManager({
    emit: (event) => events.push(event),
    openExternal: () => undefined,
    resolveWebContents: (id) => (id === contents.id ? contents : null)
  });

  await manager.registerGuest({
    nodeId: "browser-deduped-load-failure",
    profileId: null,
    sessionMode: "shared",
    webContentsId: 20
  });
  events.length = 0;
  contents.loadURL = async (url: string): Promise<void> => {
    contents.currentUrl = url;
    contents.loading = true;
    contents.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      url,
      true
    );
    throw new Error("ERR_CONNECTION_REFUSED");
  };

  await manager.navigate({
    nodeId: "browser-deduped-load-failure",
    url: "http://127.0.0.1:3000/"
  });

  assert.deepEqual(
    events.filter((event) => event.type === "error"),
    [
      {
        code: "navigation-failed",
        diagnosticMessage: "ERR_CONNECTION_REFUSED",
        nodeId: "browser-deduped-load-failure",
        params: { errorCode: -102 },
        type: "error"
      }
    ]
  );
  assert.equal(events.at(-1)?.type, "error");
});

test("keeps Browser Node guest ownership bound to one node", async () => {
  const contents = new MockBrowserGuestWebContents(9);
  const manager = createBrowserGuestManager({
    emit: () => undefined,
    openExternal: () => undefined,
    resolveWebContents: (id) => (id === contents.id ? contents : null)
  });

  await manager.registerGuest({
    nodeId: "browser-1",
    profileId: null,
    sessionMode: "shared",
    webContentsId: 9
  });
  await manager.registerGuest({
    nodeId: "browser-1",
    profileId: null,
    sessionMode: "shared",
    webContentsId: 9
  });
  assert.equal(contents.listenerCount("did-start-loading"), 1);

  await assert.rejects(
    manager.registerGuest({
      nodeId: "browser-2",
      profileId: null,
      sessionMode: "shared",
      webContentsId: 9
    }),
    /already registered/
  );

  await manager.unregisterGuest({ nodeId: "browser-1", webContentsId: 9 });
  await manager.registerGuest({
    nodeId: "browser-2",
    profileId: null,
    sessionMode: "shared",
    webContentsId: 9
  });
  assert.equal(manager.debugDump({ nodeId: "browser-2" })?.webContentsId, 9);
});

class MockBrowserGuestWebContents
  extends EventEmitter
  implements BrowserGuestWebContents
{
  backCalls = 0;
  canGoBackValue = false;
  canGoForwardValue = false;
  currentUrl = "about:blank";
  destroyed = false;
  loadedUrls: string[] = [];
  loading = false;
  title = "";
  windowOpenHandler:
    | ((details: { url: string }) => BrowserGuestWindowOpenHandlerResponse)
    | null = null;
  readonly id: number;

  constructor(id: number) {
    super();
    this.id = id;
  }

  canGoBack(): boolean {
    return this.canGoBackValue;
  }

  canGoForward(): boolean {
    return this.canGoForwardValue;
  }

  async capturePage(): Promise<BrowserGuestNativeImage> {
    const resized: BrowserGuestNativeImage = {
      toDataURL: () => "data:image/png;base64,browser-preview"
    };
    return {
      getSize: () => ({ height: 900, width: 1440 }),
      isEmpty: () => false,
      resize: () => resized,
      toDataURL: () => "data:image/png;base64,browser-preview-original"
    };
  }

  getTitle(): string {
    return this.title;
  }

  getURL(): string {
    return this.currentUrl;
  }

  getUserAgent(): string {
    return "MockBrowser/1.0";
  }

  goBack(): void {
    this.backCalls += 1;
  }

  goForward(): void {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isLoading(): boolean {
    return this.loading;
  }

  async loadURL(url: string): Promise<void> {
    this.currentUrl = url;
    this.loadedUrls.push(url);
  }

  openDevToolsCalls = 0;
  openDevToolsOptions: unknown[] = [];

  openDevTools(options?: unknown): void {
    this.openDevToolsCalls += 1;
    this.openDevToolsOptions.push(options);
  }

  reload(): void {}

  setWindowOpenHandler(
    handler: (details: { url: string }) => BrowserGuestWindowOpenHandlerResponse
  ): void {
    this.windowOpenHandler = handler;
  }
}
