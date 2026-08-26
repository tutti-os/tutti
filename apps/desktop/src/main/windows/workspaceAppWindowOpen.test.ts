import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserNodeOpenUrlEvent } from "@tutti-os/browser-node";
import type { BrowserWebviewWindowOpenHandler } from "@tutti-os/browser-node/electron-main";
import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";
import { createWorkspaceAppWindowOpenHandler } from "./workspaceAppWindowOpen.ts";

test("workspace app window-open handler emits one event for an accepted GET popup", () => {
  const events: BrowserNodeOpenUrlEvent[] = [];
  const logs: Record<string, unknown>[] = [];
  const navigatedUrls: string[] = [];
  const handler = createWorkspaceAppWindowOpenHandler({
    contents: createWindowOpenContents(99, navigatedUrls),
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
  assert.deepEqual(navigatedUrls, []);
});

test("workspace app window-open handler navigates internal popups in the current guest", async () => {
  const events: BrowserNodeOpenUrlEvent[] = [];
  const navigatedUrls: string[] = [];
  const contents = {
    getURL: () => "https://app.local/home",
    id: 98,
    async loadURL(url: string) {
      navigatedUrls.push(url);
    }
  };
  const handler = createWorkspaceAppWindowOpenHandler({
    contents,
    ownerWindow: createOwnerWindow(events)
  });

  assert.deepEqual(
    handler(createWindowOpenDetails("https://app.local/canvas?id=canvas-1")),
    { action: "deny" }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(navigatedUrls, ["https://app.local/canvas?id=canvas-1"]);
  assert.deepEqual(events, []);
});

test("workspace app window-open handler rejects POST popup bodies instead of replaying them as GET", () => {
  const events: BrowserNodeOpenUrlEvent[] = [];
  const messages: Array<{ channel: string; payload: unknown }> = [];
  const warnings: { details?: Record<string, unknown>; message: string }[] = [];
  const handler = createWorkspaceAppWindowOpenHandler({
    contents: createWindowOpenContents(100),
    logger: {
      warn(message, details) {
        warnings.push({ details, message });
      }
    },
    ownerWindow: {
      webContents: {
        send(channel: string, payload: unknown) {
          messages.push({ channel, payload });
        }
      }
    } as never
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
  assert.deepEqual(messages, [
    {
      channel: desktopIpcChannels.workspaceApp.popupRejected,
      payload: { reason: "post-unsupported" }
    }
  ]);
  assert.equal(JSON.stringify(messages).includes("code=secret"), false);
  assert.equal(JSON.stringify(warnings).includes("code=secret"), false);
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

test("workspace app window-open handler rejects deferred navigation popups explicitly", () => {
  const messages: Array<{ channel: string; payload: unknown }> = [];
  const navigatedUrls: string[] = [];
  const handler = createWorkspaceAppWindowOpenHandler({
    contents: createWindowOpenContents(102, navigatedUrls),
    ownerWindow: {
      webContents: {
        send(channel: string, payload: unknown) {
          messages.push({ channel, payload });
        }
      }
    } as never
  });

  assert.deepEqual(handler(createWindowOpenDetails("about:blank")), {
    action: "deny"
  });
  assert.deepEqual(navigatedUrls, []);
  assert.deepEqual(messages, [
    {
      channel: desktopIpcChannels.workspaceApp.popupRejected,
      payload: { reason: "deferred-navigation-unsupported" }
    }
  ]);
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

function createWindowOpenContents(id: number, navigatedUrls: string[] = []) {
  return {
    getURL: () => "https://app.local/home",
    id,
    async loadURL(url: string) {
      navigatedUrls.push(url);
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
