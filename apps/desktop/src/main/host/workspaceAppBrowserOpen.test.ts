import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserNodeOpenUrlEvent } from "@tutti-os/browser-node";
import { dispatchWorkspaceAppOpenUrl } from "./workspaceAppBrowserOpen.ts";

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
          send(_channel: string, _event: unknown) {}
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
