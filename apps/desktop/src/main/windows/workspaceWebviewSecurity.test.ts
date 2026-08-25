import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type {
  BrowserWebviewGuestAttachment,
  BrowserWebviewWindowOpenHandler
} from "@tutti-os/browser-node/electron-main";
import { installWorkspaceWindowWebviewSecurity } from "./workspaceWebviewSecurity.ts";

test("workspace webview security composes Workspace App guest routing once", () => {
  const contents = new EventEmitter();
  const ownerWindow = { id: 11 };
  const browserGuests: number[] = [];
  const workspaceAppGuests: Array<{ id: number; partition: string }> = [];
  const assetPartitions: string[] = [];
  const hostPopupUrls: string[] = [];
  const guest = createGuestContents(71);
  const cleanup = installWorkspaceWindowWebviewSecurity({
    browserNodeGuestPreloadPath: "/browser-preload.cjs",
    contents: contents as never,
    ownerWindow: ownerWindow as never,
    runtime: {
      openExternal() {
        throw new Error("Workspace App popup must keep the host route");
      },
      registerBrowserGuest(_ownerWindow, guestContents) {
        browserGuests.push(guestContents.id);
      },
      registerWorkspaceAppAssetProtocol(partition) {
        assetPartitions.push(partition);
      },
      registerWorkspaceAppGuest(_ownerWindow, guestContents, partition) {
        workspaceAppGuests.push({ id: guestContents.id, partition });
        return {
          windowOpenHandler: ({ url }) => {
            hostPopupUrls.push(url);
            return { action: "deny" };
          }
        } satisfies BrowserWebviewGuestAttachment;
      }
    },
    workspaceAppPreloadPath: "/workspace-app-preload.cjs"
  });
  const params = {
    partition: "persist:tutti-app:workspace:app",
    src: "https://workspace-app.example/"
  };
  const webPreferences: Record<string, unknown> = {};

  emitWillAttach(contents, webPreferences, params);
  contents.emit("did-attach-webview", {}, guest.contents);

  cleanup();

  assert.equal(webPreferences.preload, "/workspace-app-preload.cjs");
  assert.deepEqual(assetPartitions, ["persist:tutti-app:workspace:app"]);
  assert.deepEqual(browserGuests, [71]);
  assert.deepEqual(workspaceAppGuests, [
    { id: 71, partition: "persist:tutti-app:workspace:app" }
  ]);
  assert.equal(guest.setWindowOpenHandlerCount(), 1);
  assert.deepEqual(
    guest.windowOpenHandler()?.({
      url: "https://identity.example/authorize"
    } as never),
    { action: "deny" }
  );
  assert.deepEqual(hostPopupUrls, ["https://identity.example/authorize"]);
});

test("workspace webview security composes ordinary Browser guests without Workspace App routing", () => {
  const contents = new EventEmitter();
  const browserGuests: number[] = [];
  const workspaceAppGuests: number[] = [];
  const assetPartitions: string[] = [];
  const guest = createGuestContents(72);
  const cleanup = installWorkspaceWindowWebviewSecurity({
    browserNodeGuestPreloadPath: "/browser-preload.cjs",
    contents: contents as never,
    ownerWindow: { id: 12 } as never,
    runtime: {
      openExternal() {},
      registerBrowserGuest(_ownerWindow, guestContents) {
        browserGuests.push(guestContents.id);
      },
      registerWorkspaceAppAssetProtocol(partition) {
        assetPartitions.push(partition);
      },
      registerWorkspaceAppGuest(_ownerWindow, guestContents) {
        workspaceAppGuests.push(guestContents.id);
        return {};
      }
    },
    workspaceAppPreloadPath: "/workspace-app-preload.cjs"
  });
  const params = {
    "data-browser-node-webview": "true",
    partition: "persist:browser-node-shared",
    src: "about:blank"
  };
  const webPreferences: Record<string, unknown> = {};

  emitWillAttach(contents, webPreferences, params);
  contents.emit("did-attach-webview", {}, guest.contents);

  cleanup();

  assert.equal(webPreferences.preload, "/browser-preload.cjs");
  assert.deepEqual(browserGuests, [72]);
  assert.deepEqual(workspaceAppGuests, []);
  assert.deepEqual(assetPartitions, []);
  assert.equal(guest.setWindowOpenHandlerCount(), 1);
});

test("workspace webview security gives malformed Workspace App partitions no preload or host route", () => {
  const contents = new EventEmitter();
  const browserGuests: number[] = [];
  const workspaceAppGuests: number[] = [];
  const assetPartitions: string[] = [];
  const guest = createGuestContents(73);
  const cleanup = installWorkspaceWindowWebviewSecurity({
    browserNodeGuestPreloadPath: "/browser-preload.cjs",
    contents: contents as never,
    ownerWindow: { id: 13 } as never,
    runtime: {
      openExternal() {},
      registerBrowserGuest(_ownerWindow, guestContents) {
        browserGuests.push(guestContents.id);
      },
      registerWorkspaceAppAssetProtocol(partition) {
        assetPartitions.push(partition);
      },
      registerWorkspaceAppGuest(_ownerWindow, guestContents) {
        workspaceAppGuests.push(guestContents.id);
        return {};
      }
    },
    workspaceAppPreloadPath: "/workspace-app-preload.cjs"
  });
  const params = {
    partition: "persist:tutti-app:missing-separator",
    src: "https://workspace-app.example/"
  };
  const webPreferences: Record<string, unknown> = {};

  emitWillAttach(contents, webPreferences, params);
  contents.emit("did-attach-webview", {}, guest.contents);

  cleanup();

  assert.equal(webPreferences.preload, undefined);
  assert.deepEqual(browserGuests, [73]);
  assert.deepEqual(workspaceAppGuests, []);
  assert.deepEqual(assetPartitions, []);
  assert.equal(guest.setWindowOpenHandlerCount(), 1);
});

function emitWillAttach(
  contents: EventEmitter,
  webPreferences: Record<string, unknown>,
  params: Record<string, string>
): void {
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
}

function createGuestContents(id: number): {
  contents: EventEmitter & {
    id: number;
    setWindowOpenHandler(handler: BrowserWebviewWindowOpenHandler): void;
  };
  setWindowOpenHandlerCount(): number;
  windowOpenHandler(): BrowserWebviewWindowOpenHandler | undefined;
} {
  let handler: BrowserWebviewWindowOpenHandler | undefined;
  let setterCount = 0;
  const contents = Object.assign(new EventEmitter(), {
    id,
    setWindowOpenHandler(nextHandler: BrowserWebviewWindowOpenHandler) {
      setterCount += 1;
      handler = nextHandler;
    }
  });
  return {
    contents,
    setWindowOpenHandlerCount: () => setterCount,
    windowOpenHandler: () => handler
  };
}
