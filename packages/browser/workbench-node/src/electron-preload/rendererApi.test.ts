import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserNodeEvent } from "../core/types.ts";
import { createBrowserNodeElectronRendererApi } from "./rendererApi.ts";

const channels = {
  activate: "browser:activate",
  close: "browser:close",
  event: "browser:event",
  goBack: "browser:go-back",
  goForward: "browser:go-forward",
  navigate: "browser:navigate",
  openExternal: "browser:open-external",
  prepareSession: "browser:prepare-session",
  registerGuest: "browser:register-guest",
  reload: "browser:reload",
  unregisterGuest: "browser:unregister-guest"
} as const;

test("renderer API routes commands and events through the configured channels", async () => {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const eventListener: {
    current?: (event: unknown, payload: unknown) => void;
  } = {};
  const api = createBrowserNodeElectronRendererApi({
    channels,
    transport: {
      async invoke(channel, payload) {
        calls.push({ channel, payload });
        return undefined as never;
      },
      on(channel, listener) {
        assert.equal(channel, channels.event);
        eventListener.current = listener;
      },
      removeListener(channel, listener) {
        assert.equal(channel, channels.event);
        assert.equal(listener, eventListener.current);
        delete eventListener.current;
      }
    }
  });

  await api.navigate({ nodeId: "browser:one", url: "https://tutti.app/" });
  await api.openExternal?.({ url: "https://open.tutti.app/" });
  assert.deepEqual(calls, [
    {
      channel: channels.navigate,
      payload: { nodeId: "browser:one", url: "https://tutti.app/" }
    },
    {
      channel: channels.openExternal,
      payload: { url: "https://open.tutti.app/" }
    }
  ]);

  let received: BrowserNodeEvent | null = null;
  const unsubscribe = api.onEvent((event) => {
    received = event;
  });
  const event: BrowserNodeEvent = {
    nodeId: "browser:one",
    type: "closed"
  };
  eventListener.current?.({}, event);
  assert.deepEqual(received, event);
  unsubscribe();
  assert.equal(eventListener.current, undefined);
});

test("renderer API omits optional host capabilities without channels", () => {
  const api = createBrowserNodeElectronRendererApi({
    channels,
    transport: {
      invoke: async () => undefined as never,
      on() {},
      removeListener() {}
    }
  });

  assert.equal(api.findInPage, undefined);
  assert.equal(api.saveScreenshot, undefined);
  assert.equal(api.setDeviceEmulation, undefined);
});
