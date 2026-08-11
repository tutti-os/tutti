import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserNodeOpenUrlEvent } from "@tutti-os/browser-node";
import type { BrowserWebviewWindowOpenHandler } from "@tutti-os/browser-node/electron-main";
import {
  createWorkspaceAppWindowOpenHandler,
  dispatchWorkspaceAppOpenUrl
} from "./workspaceAppWindowOpen.ts";

test("workspace app window-open handler emits one event for an accepted GET popup", () => {
  const events: BrowserNodeOpenUrlEvent[] = [];
  const logs: Record<string, unknown>[] = [];
  const handler = createWorkspaceAppWindowOpenHandler({
    contents: { id: 99 },
    logger: {
      info(_message, details) {
        logs.push(details ?? {});
      }
    },
    ownerWindow: createOwnerWindow(events)
  });

  assert.deepEqual(
    handler(createWindowOpenDetails("https://example.com/auth")),
    {
      action: "deny"
    }
  );
  assert.deepEqual(events, [
    {
      reuseIfOpen: false,
      sourceNodeId: "workspace-app:99",
      type: "open-url",
      url: "https://example.com/auth"
    }
  ]);
  assert.deepEqual(logs, [
    {
      producer: "window-open-handler",
      sourceNodeId: "workspace-app:99",
      url: "https://example.com/auth",
      webContentsId: 99
    }
  ]);
});

test("workspace app window-open handler rejects POST popup bodies instead of replaying them as GET", () => {
  const events: BrowserNodeOpenUrlEvent[] = [];
  const warnings: { details?: Record<string, unknown>; message: string }[] = [];
  const handler = createWorkspaceAppWindowOpenHandler({
    contents: { id: 100 },
    logger: {
      warn(message, details) {
        warnings.push({ details, message });
      }
    },
    ownerWindow: createOwnerWindow(events)
  });

  assert.deepEqual(
    handler(
      createWindowOpenDetails("https://example.com/auth", {
        postBody: {
          contentType: "application/x-www-form-urlencoded",
          data: [{ bytes: Buffer.from("code=secret"), type: "rawData" }]
        }
      })
    ),
    { action: "deny" }
  );
  assert.deepEqual(events, []);
  assert.deepEqual(warnings, [
    {
      details: {
        contentType: "application/x-www-form-urlencoded",
        url: "https://example.com/auth",
        webContentsId: 100
      },
      message: "workspace app guest rejected POST popup"
    }
  ]);
});

test("workspace app open-url dispatch emits no event for invalid URLs or unavailable owners", () => {
  const events: BrowserNodeOpenUrlEvent[] = [];
  const contents = { id: 101 };

  assert.equal(
    dispatchWorkspaceAppOpenUrl({
      contents,
      ownerWindow: createOwnerWindow(events),
      producer: "external-browser-api",
      url: "javascript:alert(1)"
    }),
    false
  );
  assert.equal(
    dispatchWorkspaceAppOpenUrl({
      contents,
      ownerWindow: {
        isDestroyed: () => true,
        webContents: {
          send(_channel, event) {
            events.push(event);
          }
        }
      },
      producer: "window-open-handler",
      url: "https://example.com/"
    }),
    false
  );
  assert.deepEqual(events, []);
});

function createOwnerWindow(events: BrowserNodeOpenUrlEvent[]) {
  return {
    webContents: {
      send(_channel: string, event: BrowserNodeOpenUrlEvent) {
        events.push(event);
      }
    }
  };
}

function createWindowOpenDetails(
  url: string,
  overrides: Partial<Parameters<BrowserWebviewWindowOpenHandler>[0]> = {}
): Parameters<BrowserWebviewWindowOpenHandler>[0] {
  return {
    disposition: "new-window",
    features: "",
    frameName: "_blank",
    referrer: { policy: "default", url: "https://app.local/" },
    url,
    ...overrides
  };
}
