import assert from "node:assert/strict";
import test from "node:test";

import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";
import {
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
        reuseIfOpen: true,
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
        reuseIfOpen: true,
        sourceNodeId: "workspace-app:99",
        type: "open-url",
        url: "https://www.producthunt.com/products/vc-boom"
      }
    }
  ]);
});
