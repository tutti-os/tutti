import assert from "node:assert/strict";
import test from "node:test";

import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";
import {
  dispatchWorkspaceAppExternalOpenUrl,
  dispatchWorkspaceAppOpenUrl,
  installWorkspaceAppWindowOpenHandler
} from "./workspaceAppWindowOpen.ts";

test("workspace app native window-open requests dispatch Browser Node open-url events", () => {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const logs: Array<{ message: string; details?: Record<string, unknown> }> =
    [];
  type WindowOpenHandler = (details: { url: string }) => {
    action: "allow" | "deny";
  };
  const captured: { windowOpenHandler?: WindowOpenHandler } = {};

  installWorkspaceAppWindowOpenHandler({
    contents: {
      id: 99,
      setWindowOpenHandler(handler) {
        captured.windowOpenHandler = handler;
      }
    },
    logger: {
      warn(message, details) {
        logs.push({ details, message });
      }
    },
    ownerWindow: {
      webContents: {
        send(channel, payload) {
          sent.push({ channel, payload });
        }
      }
    }
  });

  if (!captured.windowOpenHandler) {
    throw new Error("expected a window-open handler to be installed");
  }

  assert.deepEqual(
    captured.windowOpenHandler({
      url: "https://www.producthunt.com/products/google-labs"
    }),
    { action: "deny" }
  );
  assert.deepEqual(logs, []);
  assert.deepEqual(sent, [
    {
      channel: desktopIpcChannels.browser.event,
      payload: {
        reuseIfOpen: false,
        sourceNodeId: "workspace-app:99",
        type: "open-url",
        url: "https://www.producthunt.com/products/google-labs"
      }
    }
  ]);
});

test("workspace app preload open-url requests dispatch Browser Node open-url events", () => {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const logs: Array<{ message: string; details?: Record<string, unknown> }> =
    [];

  const result = dispatchWorkspaceAppOpenUrl({
    contents: {
      id: 99
    },
    logger: {
      warn(message, details) {
        logs.push({ details, message });
      }
    },
    ownerWindow: {
      webContents: {
        send(channel, payload) {
          sent.push({ channel, payload });
        }
      }
    },
    url: "https://www.producthunt.com/products/vc-boom"
  });

  assert.equal(result, true);
  assert.deepEqual(logs, []);
  assert.deepEqual(sent, [
    {
      channel: desktopIpcChannels.browser.event,
      payload: {
        reuseIfOpen: false,
        sourceNodeId: "workspace-app:99",
        type: "open-url",
        url: "https://www.producthunt.com/products/vc-boom"
      }
    }
  ]);
});

test("workspace app JSB open-url rejects bare hostnames and non-HTTP URLs in main", () => {
  const sent: unknown[] = [];
  const warnings: string[] = [];
  const input = {
    contents: { id: 99 },
    logger: {
      warn(message: string) {
        warnings.push(message);
      }
    },
    ownerWindow: {
      webContents: {
        send(_channel: string, payload: unknown) {
          sent.push(payload);
        }
      }
    }
  };

  assert.equal(
    dispatchWorkspaceAppExternalOpenUrl({
      ...input,
      payload: { url: "example.com" }
    }),
    false
  );
  assert.equal(
    dispatchWorkspaceAppExternalOpenUrl({
      ...input,
      payload: { url: "file:///tmp/report.html" }
    }),
    false
  );
  assert.deepEqual(sent, []);
  assert.equal(warnings.length, 2);
});

test("workspace app JSB open-url canonicalizes HTTP URLs in main", () => {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const result = dispatchWorkspaceAppExternalOpenUrl({
    contents: { id: 99 },
    ownerWindow: {
      webContents: {
        send(channel, payload) {
          sent.push({ channel, payload });
        }
      }
    },
    payload: { url: " https://example.com/design " }
  });

  assert.equal(result, true);
  assert.equal(
    (sent[0]?.payload as { url?: string } | undefined)?.url,
    "https://example.com/design"
  );
});
