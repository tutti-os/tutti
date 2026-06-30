import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDesktopBrowserPreferredColorScheme,
  syncPreferredColorSchemeViaDebugger,
  type BrowserColorSchemeDebugger
} from "./browserPreferredColorScheme.ts";

test("desktop browser preferred color scheme honors explicit theme choices", () => {
  assert.equal(
    resolveDesktopBrowserPreferredColorScheme({
      nativeShouldUseDarkColors: true,
      themeSource: "light"
    }),
    "light"
  );
  assert.equal(
    resolveDesktopBrowserPreferredColorScheme({
      nativeShouldUseDarkColors: false,
      themeSource: "dark"
    }),
    "dark"
  );
});

test("desktop browser preferred color scheme follows native theme for system source", () => {
  assert.equal(
    resolveDesktopBrowserPreferredColorScheme({
      nativeShouldUseDarkColors: true,
      themeSource: "system"
    }),
    "dark"
  );
  assert.equal(
    resolveDesktopBrowserPreferredColorScheme({
      nativeShouldUseDarkColors: false,
      themeSource: "system"
    }),
    "light"
  );
});

function createMockDebugger(
  overrides: Partial<BrowserColorSchemeDebugger> = {}
): BrowserColorSchemeDebugger & {
  attachCalls: number;
  detachCalls: number;
  sentCommands: Array<{ command: string; params: unknown }>;
} {
  let attached = false;
  let attachCalls = 0;
  let detachCalls = 0;
  const sentCommands: Array<{ command: string; params: unknown }> = [];
  return {
    isAttached: () => attached,
    attach() {
      attachCalls += 1;
      attached = true;
    },
    detach() {
      detachCalls += 1;
      attached = false;
    },
    async sendCommand(command, params) {
      sentCommands.push({ command, params });
    },
    ...overrides,
    get attachCalls() {
      return attachCalls;
    },
    get detachCalls() {
      return detachCalls;
    },
    get sentCommands() {
      return sentCommands;
    }
  } as BrowserColorSchemeDebugger & {
    attachCalls: number;
    detachCalls: number;
    sentCommands: Array<{ command: string; params: unknown }>;
  };
}

test("syncPreferredColorScheme does not detach debugger after success (#437)", async () => {
  const mock = createMockDebugger();
  await syncPreferredColorSchemeViaDebugger(mock, "dark");

  assert.equal(mock.attachCalls, 1, "should attach debugger");
  assert.equal(mock.detachCalls, 0, "should NOT detach after success");
  assert.equal(mock.isAttached(), true, "debugger stays attached");
  assert.equal(mock.sentCommands.length, 1);
  assert.equal(mock.sentCommands[0]?.command, "Emulation.setEmulatedMedia");
});

test("syncPreferredColorScheme detaches debugger on error", async () => {
  const mock = createMockDebugger({
    async sendCommand() {
      throw new Error("CDP error");
    }
  });

  await assert.rejects(
    syncPreferredColorSchemeViaDebugger(mock, "dark"),
    /CDP error/
  );

  assert.equal(mock.attachCalls, 1, "should attach debugger");
  assert.equal(mock.detachCalls, 1, "should detach on error");
  assert.equal(mock.isAttached(), false, "debugger detached after error");
});

test("syncPreferredColorScheme does not detach when debugger was already attached", async () => {
  let attached = true;
  const mock = createMockDebugger({
    isAttached: () => attached,
    attach() {
      attached = true;
    },
    detach() {
      attached = false;
    }
  });

  await syncPreferredColorSchemeViaDebugger(mock, "light");

  assert.equal(mock.isAttached(), true, "debugger stays attached");
  assert.equal(mock.detachCalls, 0, "should NOT detach");
});
