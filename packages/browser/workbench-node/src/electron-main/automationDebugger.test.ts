import assert from "node:assert/strict";
import test from "node:test";
import { BrowserNodeAutomationDriver } from "./automationDebugger.ts";
import type { BrowserGuestDebugger, BrowserGuestWebContents } from "./types.ts";

test("automation request guard intercepts redirects and subresources", async () => {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> =
    [];
  let attached = false;
  let messageListener:
    | ((event: unknown, method: string, params: unknown) => void)
    | null = null;
  const debuggerClient: BrowserGuestDebugger = {
    attach() {
      attached = true;
    },
    detach() {
      attached = false;
    },
    isAttached: () => attached,
    off(_event, listener) {
      if (messageListener === listener) messageListener = null;
      return this;
    },
    on(_event, listener) {
      messageListener = listener;
      return this;
    },
    async sendCommand(method, params) {
      commands.push({ method, ...(params ? { params } : {}) });
      return {};
    }
  };
  const contents = {
    debugger: debuggerClient,
    isDestroyed: () => false,
    off() {
      return this;
    },
    on() {
      return this;
    }
  } as unknown as BrowserGuestWebContents;
  const driver = new BrowserNodeAutomationDriver(contents);
  await driver.enableRequestGuard(async (url) =>
    url.startsWith("https://public.example/")
      ? { allowed: true }
      : {
          allowed: false,
          code: "private_network_blocked",
          message: "blocked"
        }
  );

  const emitMessage = messageListener as
    | ((event: unknown, method: string, params: unknown) => void)
    | null;
  assert.ok(emitMessage);
  emitMessage(null, "Fetch.requestPaused", {
    request: { url: "https://public.example/script.js" },
    requestId: "public"
  });
  emitMessage(null, "Fetch.requestPaused", {
    request: { url: "http://169.254.169.254/latest/meta-data" },
    requestId: "private"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    commands.some(
      ({ method, params }) =>
        method === "Fetch.continueRequest" && params?.requestId === "public"
    )
  );
  assert.ok(
    commands.some(
      ({ method, params }) =>
        method === "Fetch.failRequest" && params?.requestId === "private"
    )
  );
  driver.dispose();
});

test("automation driver disposal does not access a destroyed WebContents debugger", async () => {
  let destroyed = false;
  let messageListener:
    | ((event: unknown, method: string, params: unknown) => void)
    | null = null;
  const debuggerClient: BrowserGuestDebugger = {
    attach() {},
    detach() {},
    isAttached: () => true,
    off(_event, listener) {
      if (messageListener === listener) messageListener = null;
      return this;
    },
    on(_event, listener) {
      messageListener = listener;
      return this;
    },
    async sendCommand() {
      return {};
    }
  };
  const contents = {
    get debugger() {
      if (destroyed) throw new TypeError("Object has been destroyed");
      return debuggerClient;
    },
    isDestroyed: () => destroyed,
    off() {
      return this;
    },
    on() {
      return this;
    }
  } as unknown as BrowserGuestWebContents;
  const driver = new BrowserNodeAutomationDriver(contents);
  await driver.enableRequestGuard(async () => ({ allowed: true }));
  const emitMessage = messageListener as
    | ((event: unknown, method: string, params: unknown) => void)
    | null;

  destroyed = true;
  emitMessage?.(null, "Fetch.requestPaused", {
    request: { url: "https://public.example/late.js" },
    requestId: "late"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.doesNotReject(driver.disableRequestGuard());
  assert.doesNotThrow(() => driver.dispose());
  assert.doesNotThrow(() => driver.dispose());
});
