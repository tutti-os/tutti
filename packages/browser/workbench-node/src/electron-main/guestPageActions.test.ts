import assert from "node:assert/strict";
import test from "node:test";
import {
  saveBrowserGuestScreenshot,
  setBrowserGuestDeviceEmulation
} from "./guestPageActions.ts";
import type {
  BrowserGuestDebugger,
  BrowserGuestDeviceEmulationParameters,
  BrowserGuestWebContents
} from "./types.ts";

test("captures a complete page through the debugging protocol and detaches", async () => {
  let attached = false;
  const commands: Array<{
    method: string;
    parameters?: Record<string, unknown>;
  }> = [];
  const browserDebugger: BrowserGuestDebugger = {
    attach() {
      attached = true;
    },
    detach() {
      attached = false;
    },
    isAttached: () => attached,
    async sendCommand(method, parameters) {
      commands.push({ method, parameters });
      return method === "Page.getLayoutMetrics"
        ? { cssContentSize: { height: 2400.2, width: 1200 } }
        : { data: "full-page-png" };
    }
  };
  const contents = {
    debugger: browserDebugger,
    getTitle: () => "Full page",
    isDestroyed: () => false
  } as BrowserGuestWebContents;

  let savedDataUrl = "";
  const result = await saveBrowserGuestScreenshot(
    contents,
    { mode: "full-page", nodeId: "node-1" },
    async (capture) => {
      savedDataUrl = capture.dataUrl;
      return { filePath: "/tmp/full.png", saved: true };
    }
  );

  assert.deepEqual(result, { filePath: "/tmp/full.png", saved: true });
  assert.equal(savedDataUrl, "data:image/png;base64,full-page-png");
  assert.equal(attached, false);
  assert.deepEqual(
    commands.map((command) => command.method),
    ["Page.getLayoutMetrics", "Page.captureScreenshot"]
  );
  assert.deepEqual(
    (commands[1]?.parameters?.clip as Record<string, unknown>) ?? null,
    { height: 2401, scale: 1, width: 1200, x: 0, y: 0 }
  );
});

test("applies and disables fixed device emulation presets", () => {
  const parameters: BrowserGuestDeviceEmulationParameters[] = [];
  let disableCalls = 0;
  const contents = {
    disableDeviceEmulation() {
      disableCalls += 1;
    },
    enableDeviceEmulation(value: BrowserGuestDeviceEmulationParameters) {
      parameters.push(value);
    },
    isDestroyed: () => false
  } as BrowserGuestWebContents;

  assert.equal(setBrowserGuestDeviceEmulation(contents, "iphone-14"), true);
  assert.deepEqual(parameters[0], {
    deviceScaleFactor: 3,
    scale: 1,
    screenPosition: "mobile",
    screenSize: { height: 844, width: 390 },
    viewSize: { height: 844, width: 390 }
  });
  assert.equal(setBrowserGuestDeviceEmulation(contents, "desktop"), true);
  assert.equal(disableCalls, 1);
});
