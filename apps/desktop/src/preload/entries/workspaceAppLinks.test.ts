import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeFeature } from "@tutti-os/browser-node";
import type {
  BrowserNodeEvent,
  BrowserNodeHostApi,
  BrowserNodeOpenUrlEvent
} from "@tutti-os/browser-node";
import {
  dispatchWorkspaceAppOpenUrl,
  installWorkspaceAppWindowOpenHandler
} from "../../main/ipc/workspaceAppWindowOpen.ts";
import { createWorkspaceBrowserService } from "../../renderer/src/features/workspace-workbench/services/internal/workspaceBrowserService.ts";
import {
  registerWorkspaceBrowserLaunchHandler,
  type WorkspaceBrowserLaunchRequest
} from "../../renderer/src/features/workspace-workbench/services/workspaceBrowserLaunchCoordinator.ts";

import { installWorkspaceAppLinkInterception } from "./workspaceAppLinks.ts";

type MainWorldExecutionScript = {
  args?: unknown[];
  func: (...args: never[]) => unknown;
};

function installFakeAnchorGlobals(): () => void {
  const originalElement = globalThis.Element;
  const originalHTMLAnchorElement = globalThis.HTMLAnchorElement;

  Object.assign(globalThis, {
    Element: FakeElement,
    HTMLAnchorElement: FakeAnchorElement
  });

  return () => {
    Object.assign(globalThis, {
      Element: originalElement,
      HTMLAnchorElement: originalHTMLAnchorElement
    });
  };
}

class FakeElement {
  parentElement: FakeElement | null = null;

  closest(): FakeElement | null {
    return null;
  }
}

class FakeAnchorElement extends FakeElement {
  href: string;
  private readonly attrs = new Map<string, string>();

  constructor(href: string, target = "_blank") {
    super();
    this.href = href;
    this.attrs.set("target", target);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
}

function createClickEvent(anchor: FakeAnchorElement): MouseEvent & {
  stopped: boolean;
  stoppedImmediate: boolean;
} {
  const event = {
    altKey: false,
    button: 0,
    composedPath: () => [anchor],
    ctrlKey: false,
    defaultPrevented: false,
    metaKey: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    shiftKey: false,
    stopImmediatePropagation() {
      event.stoppedImmediate = true;
    },
    stopPropagation() {
      event.stopped = true;
    },
    stopped: false,
    stoppedImmediate: false,
    target: anchor
  };

  return event as unknown as MouseEvent & {
    stopped: boolean;
    stoppedImmediate: boolean;
  };
}

function createFakeWindow(input?: {
  href?: string;
  open?: Window["open"];
}): Window & {
  assignedUrls: string[];
  listeners: EventListener[];
} {
  const listeners: EventListener[] = [];
  const assignedUrls: string[] = [];
  const fakeWindow = {
    assignedUrls,
    document: { readyState: "complete" },
    listeners,
    location: {
      assign(url: string) {
        assignedUrls.push(url);
      },
      href: input?.href ?? "https://app.local"
    },
    open: input?.open,
    addEventListener(type: string, listener: EventListener) {
      if (type === "click") {
        listeners.push(listener);
      }
    },
    removeEventListener(type: string, listener: EventListener) {
      if (type !== "click") {
        return;
      }
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    }
  };

  return fakeWindow as unknown as Window & {
    assignedUrls: string[];
    listeners: EventListener[];
  };
}

function createBoundaryBrowserApi(
  setListener: (listener: (event: BrowserNodeEvent) => void) => void
): BrowserNodeHostApi {
  return {
    activate: () => Promise.resolve(),
    close: () => Promise.resolve(),
    goBack: () => Promise.resolve(),
    goForward: () => Promise.resolve(),
    navigate: () => Promise.resolve(),
    onEvent(listener) {
      setListener(listener);
      return () => setListener(() => undefined);
    },
    prepareSession: () => Promise.resolve(),
    registerGuest: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    unregisterGuest: () => Promise.resolve()
  };
}

test("workspace app link interception forwards _blank opens through workspace app IPC", () => {
  const restoreGlobals = installFakeAnchorGlobals();
  const fakeWindow = createFakeWindow();
  const sent: Array<{ channel: string; payload: unknown }> = [];

  try {
    const dispose = installWorkspaceAppLinkInterception({
      scope: fakeWindow,
      send(channel, payload) {
        sent.push({ channel, payload });
      }
    });

    assert.equal(fakeWindow.listeners.length, 1);

    const anchor = new FakeAnchorElement("https://example.com/product");
    const event = createClickEvent(anchor);

    fakeWindow.listeners[0]?.(event);

    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true);
    assert.equal(event.stoppedImmediate, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.channel, "workspace-app:open-url");
    const payload = sent[0]?.payload as Record<string, unknown>;
    assert.equal(typeof payload.operationId, "string");
    assert.equal(payload.url, "https://example.com/product");

    dispose();

    assert.equal(fakeWindow.listeners.length, 0);
  } finally {
    restoreGlobals();
  }
});

test("one Workspace App blank-link operation uses one entry and launches one Browser", async () => {
  const restoreGlobals = installFakeAnchorGlobals();
  let emitDesktopBrowserEvent = (_event: BrowserNodeEvent): void => undefined;
  let nativeWindowOpen:
    | ((details: { url: string }) => { action: "allow" | "deny" })
    | undefined;
  const entryCounts = { nativeWindowOpen: 0, preloadIpc: 0 };
  const launchRequests: WorkspaceBrowserLaunchRequest[] = [];
  const emittedEvents: BrowserNodeOpenUrlEvent[] = [];
  const emittedEntries: unknown[] = [];
  const logger = {
    info(_message: string, details?: Record<string, unknown>) {
      if (details?.entry) {
        emittedEntries.push(details.entry);
      }
    }
  };
  const workspaceId = "workspace-app-popup-boundary";
  const service = createWorkspaceBrowserService({
    browserApi: createBoundaryBrowserApi((listener) => {
      emitDesktopBrowserEvent = listener;
    })
  });
  const appFeature = createBrowserNodeFeature({
    hostApi: service.createFeatureHostApi({
      acceptsEvent: (event) =>
        (event.type === "open-url"
          ? event.sourceNodeId
          : event.nodeId
        ).startsWith("workspace-app:"),
      source: "workspace_app",
      workspaceId
    })
  });
  const ownerWindow = {
    webContents: {
      send(_channel: string, event: BrowserNodeOpenUrlEvent) {
        emittedEvents.push(event);
        emitDesktopBrowserEvent(event);
      }
    }
  };
  const contents = {
    id: 99,
    setWindowOpenHandler(
      handler: (details: { url: string }) => { action: "allow" | "deny" }
    ) {
      nativeWindowOpen = (details) => {
        entryCounts.nativeWindowOpen += 1;
        return handler(details);
      };
    }
  };
  const fakeWindow = createFakeWindow({
    open(url) {
      nativeWindowOpen?.({ url: String(url) });
      return null;
    }
  });
  const disposeLaunchHandler = registerWorkspaceBrowserLaunchHandler(
    workspaceId,
    (request) => {
      launchRequests.push(request);
      return "browser:authorization";
    }
  );

  try {
    service.ensureFeatureConnected(appFeature);
    installWorkspaceAppWindowOpenHandler({ contents, logger, ownerWindow });
    const disposeLinkInterception = installWorkspaceAppLinkInterception({
      scope: fakeWindow,
      send(_channel, payload) {
        entryCounts.preloadIpc += 1;
        const request = payload as { operationId: string; url: string };
        dispatchWorkspaceAppOpenUrl({
          contents,
          entry: "preload-ipc",
          logger,
          operationId: request.operationId,
          ownerWindow,
          url: request.url
        });
      }
    });
    const anchor = new FakeAnchorElement(
      "https://open.feishu.cn/open-apis/authen/v1/authorize"
    );
    const click = createClickEvent(anchor);

    fakeWindow.listeners[0]?.(click);
    if (!click.defaultPrevented) {
      fakeWindow.open(anchor.href, "_blank");
    }
    await Promise.resolve();

    assert.deepEqual(entryCounts, { nativeWindowOpen: 0, preloadIpc: 1 });
    assert.deepEqual(emittedEntries, ["preload-ipc"]);
    assert.equal(emittedEvents.length, 1);
    assert.equal(typeof emittedEvents[0]?.operationId, "string");
    assert.equal(launchRequests.length, 1);

    fakeWindow.open(anchor.href, "_blank");
    await Promise.resolve();

    assert.deepEqual(entryCounts, { nativeWindowOpen: 1, preloadIpc: 1 });
    assert.deepEqual(emittedEntries, ["preload-ipc", "native-window-open"]);
    assert.equal(emittedEvents.length, 2);
    assert.notEqual(
      emittedEvents[0]?.operationId,
      emittedEvents[1]?.operationId
    );
    assert.equal(launchRequests.length, 2);
    disposeLinkInterception();
  } finally {
    disposeLaunchHandler();
    service.disposeWorkspace(workspaceId);
    restoreGlobals();
  }
});

test("workspace app link interception navigates same-origin _blank anchors in place", () => {
  const restoreGlobals = installFakeAnchorGlobals();
  const fakeWindow = createFakeWindow({
    href: "https://app.local/home"
  });
  const sent: Array<{ channel: string; payload: unknown }> = [];

  try {
    const dispose = installWorkspaceAppLinkInterception({
      scope: fakeWindow,
      send(channel, payload) {
        sent.push({ channel, payload });
      }
    });

    const anchor = new FakeAnchorElement(
      "https://app.local/canvas?id=canvas-1"
    );
    const event = createClickEvent(anchor);

    fakeWindow.listeners[0]?.(event);

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(fakeWindow.assignedUrls, [
      "https://app.local/canvas?id=canvas-1"
    ]);
    assert.deepEqual(sent, []);

    dispose();
  } finally {
    restoreGlobals();
  }
});

test("workspace app link interception navigates same-origin window.open calls in place", () => {
  const originalOpenCalls: unknown[][] = [];
  const fakeWindow = createFakeWindow({
    href: "https://app.local/home",
    open(...args) {
      originalOpenCalls.push(args);
      return null;
    }
  });
  const sent: Array<{ channel: string; payload: unknown }> = [];

  const dispose = installWorkspaceAppLinkInterception({
    scope: fakeWindow,
    send(channel, payload) {
      sent.push({ channel, payload });
    }
  });

  const opened = fakeWindow.open("/canvas?id=canvas-1", "_blank");

  assert.equal(opened, fakeWindow);
  assert.deepEqual(fakeWindow.assignedUrls, [
    "https://app.local/canvas?id=canvas-1"
  ]);
  assert.deepEqual(originalOpenCalls, []);
  assert.deepEqual(sent, []);

  dispose();
});

test("workspace app link interception delegates cross-origin window.open calls", () => {
  const nativeWindow = {} as WindowProxy;
  const originalOpenCalls: unknown[][] = [];
  const fakeWindow = createFakeWindow({
    href: "https://app.local/home",
    open(...args) {
      originalOpenCalls.push(args);
      return nativeWindow;
    }
  });

  const dispose = installWorkspaceAppLinkInterception({
    scope: fakeWindow,
    send() {}
  });

  const opened = fakeWindow.open(
    "https://example.com/product",
    "_blank",
    "noopener"
  );

  assert.equal(opened, nativeWindow);
  assert.deepEqual(originalOpenCalls, [
    ["https://example.com/product", "_blank", "noopener"]
  ]);
  assert.deepEqual(fakeWindow.assignedUrls, []);

  dispose();

  assert.equal(
    fakeWindow.open("https://example.com/after-dispose"),
    nativeWindow
  );
  assert.deepEqual(originalOpenCalls, [
    ["https://example.com/product", "_blank", "noopener"],
    ["https://example.com/after-dispose"]
  ]);
});

test("workspace app link interception installs same-origin window.open handling in the main world", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const mainWorldWindow = createFakeWindow({
    href: "https://app.local/home",
    open() {
      return null;
    }
  });
  const isolatedWorldWindow = createFakeWindow({
    href: "https://app.local/home"
  });
  const diagnostics: unknown[] = [];

  try {
    (globalThis as { window?: unknown }).window = mainWorldWindow;
    const dispose = installWorkspaceAppLinkInterception({
      executeInMainWorld(script: MainWorldExecutionScript) {
        return script.func(...((script.args ?? []) as never[]));
      },
      reportDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
      scope: isolatedWorldWindow,
      send() {}
    });

    const opened = mainWorldWindow.open("/canvas?id=canvas-1", "_blank");

    assert.equal(opened, mainWorldWindow);
    assert.deepEqual(mainWorldWindow.assignedUrls, [
      "https://app.local/canvas?id=canvas-1"
    ]);
    assert.deepEqual(
      diagnostics.filter(
        (diagnostic) =>
          typeof diagnostic === "object" &&
          diagnostic !== null &&
          "action" in diagnostic &&
          diagnostic.action === "installed-main-world"
      ),
      [{ action: "installed-main-world" }]
    );

    dispose();
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});
