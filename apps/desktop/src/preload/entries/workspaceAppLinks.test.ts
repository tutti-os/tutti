import assert from "node:assert/strict";
import test from "node:test";
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

test("workspace app link interception delegates cross-origin _blank opens to Electron", () => {
  const restoreGlobals = installFakeAnchorGlobals();
  const fakeWindow = createFakeWindow();
  const diagnostics: unknown[] = [];

  try {
    const dispose = installWorkspaceAppLinkInterception({
      reportDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
      scope: fakeWindow
    });

    assert.equal(fakeWindow.listeners.length, 1);

    const anchor = new FakeAnchorElement("https://example.com/product");
    const event = createClickEvent(anchor);

    fakeWindow.listeners[0]?.(event);

    assert.equal(event.defaultPrevented, false);
    assert.equal(event.stopped, false);
    assert.equal(event.stoppedImmediate, false);
    assert.deepEqual(diagnostics.at(-1), {
      action: "delegate-window-open",
      button: 0,
      defaultPrevented: false,
      href: "https://example.com/product",
      modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      target: "_blank"
    });

    dispose();

    assert.equal(fakeWindow.listeners.length, 0);
  } finally {
    restoreGlobals();
  }
});

test("workspace app link interception navigates same-origin _blank anchors in place", () => {
  const restoreGlobals = installFakeAnchorGlobals();
  const fakeWindow = createFakeWindow({
    href: "https://app.local/home"
  });

  try {
    const dispose = installWorkspaceAppLinkInterception({
      scope: fakeWindow
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
  const dispose = installWorkspaceAppLinkInterception({
    scope: fakeWindow
  });

  const opened = fakeWindow.open("/canvas?id=canvas-1", "_blank");

  assert.equal(opened, fakeWindow);
  assert.deepEqual(fakeWindow.assignedUrls, [
    "https://app.local/canvas?id=canvas-1"
  ]);
  assert.deepEqual(originalOpenCalls, []);
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
    scope: fakeWindow
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
      scope: isolatedWorldWindow
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
