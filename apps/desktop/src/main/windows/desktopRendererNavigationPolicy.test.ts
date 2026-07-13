import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installDesktopRendererNavigationPolicy } from "./desktopRendererNavigationPolicy.ts";

test("desktop renderer navigation allows only one exact immutable intent", () => {
  const target = createTarget();
  const blocked: string[] = [];
  const policy = installDesktopRendererNavigationPolicy({
    contents: target.contents,
    logger: { warn() {} },
    openExternal: (url) => {
      blocked.push(url);
    }
  });
  const trusted =
    "http://127.0.0.1:5173/?view=fusion-dock&workspaceId=workspace-1";
  policy.authorize(trusted);

  assert.equal(emitNavigation(target.events, "will-navigate", trusted), false);
  assert.equal(
    emitNavigation(
      target.events,
      "will-navigate",
      "http://127.0.0.1:5173/?view=fusion-tool&workspaceId=workspace-1"
    ),
    true
  );
  assert.throws(
    () =>
      policy.authorize(
        "http://127.0.0.1:5173/?view=fusion-dock&workspaceId=workspace-2"
      ),
    /immutable/
  );
  assert.deepEqual(blocked, [
    "http://127.0.0.1:5173/?view=fusion-tool&workspaceId=workspace-1"
  ]);
});

test("desktop renderer navigation rejects redirects and other packaged files", () => {
  const target = createTarget();
  const opened: string[] = [];
  const policy = installDesktopRendererNavigationPolicy({
    contents: target.contents,
    logger: { warn() {} },
    openExternal: (url) => {
      opened.push(url);
    }
  });
  const trusted =
    "file:///Applications/Tutti.app/Contents/Resources/app.asar/out/renderer/index.html?view=workspace";
  policy.authorize(trusted);

  assert.equal(emitNavigation(target.events, "will-navigate", trusted), false);
  assert.equal(
    emitNavigation(
      target.events,
      "will-navigate",
      "file:///Users/example/private.html"
    ),
    true
  );
  assert.equal(
    emitNavigation(
      target.events,
      "will-redirect",
      "https://example.com/redirect"
    ),
    true
  );
  assert.deepEqual(opened, []);
});

test("desktop renderer popups are denied and safe web links open externally", () => {
  const target = createTarget();
  const opened: string[] = [];
  installDesktopRendererNavigationPolicy({
    contents: target.contents,
    logger: { warn() {} },
    openExternal: (url) => {
      opened.push(url);
    }
  });

  assert.deepEqual(target.openWindow("https://example.com/docs"), {
    action: "deny"
  });
  assert.deepEqual(target.openWindow("file:///Users/example/private.html"), {
    action: "deny"
  });
  assert.deepEqual(opened, ["https://example.com/docs"]);
});

function createTarget() {
  const events = new EventEmitter();
  let windowOpenHandler:
    | ((details: { url: string }) => { action: "deny" })
    | null = null;
  return {
    contents: {
      off: events.off.bind(events),
      on: events.on.bind(events),
      setWindowOpenHandler(
        handler: (details: { url: string }) => { action: "deny" }
      ) {
        windowOpenHandler = handler;
      }
    },
    events,
    openWindow(url: string) {
      if (!windowOpenHandler) {
        throw new Error("window-open handler is unavailable");
      }
      return windowOpenHandler({ url });
    }
  };
}

function emitNavigation(
  events: EventEmitter,
  name: "will-navigate" | "will-redirect",
  url: string
): boolean {
  let prevented = false;
  events.emit(
    name,
    {
      preventDefault() {
        prevented = true;
      }
    },
    url
  );
  return prevented;
}
