import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow, MessageBoxOptions } from "electron";
import type { DesktopFeatureFlags } from "../shared/preferences/index.ts";
import {
  connectDesktopFusionModeRestartCoordinator,
  resolveFusionModeRestartPromptOwner
} from "./fusionModeRestartCoordinator.ts";

test("Fusion mode restart coordinator observes authoritative preferences while Workspace mode is active", async () => {
  const fixture = createPreferencesFixture({});
  const dialogs: MessageBoxOptions[] = [];
  const lifecycleEvents: string[] = [];
  const coordinator = connectDesktopFusionModeRestartCoordinator({
    currentProcessModeActive: false,
    getLocale: () => "en",
    logger: createLogger(),
    preferences: fixture.preferences,
    quit() {
      lifecycleEvents.push("quit");
    },
    readPersistedMode: async () => true,
    relaunch() {
      lifecycleEvents.push("relaunch");
    },
    showMessageBox(options) {
      dialogs.push(options);
      return Promise.resolve({ response: 0 });
    }
  });

  fixture.sync({ "lab.fusionMode": true });
  await flushAsyncWork();

  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0]?.message, "Turn on Fusion Mode?");
  assert.deepEqual(dialogs[0]?.buttons, ["Restart Now", "Later"]);
  assert.deepEqual(lifecycleEvents, ["relaunch", "quit"]);
  coordinator.dispose();
});

test("Fusion mode restart coordinator localizes the disable prompt and suppresses Later for the same target", async () => {
  const fixture = createPreferencesFixture({ "lab.fusionMode": true });
  const dialogs: MessageBoxOptions[] = [];
  const coordinator = connectDesktopFusionModeRestartCoordinator({
    currentProcessModeActive: true,
    getLocale: () => "zh-CN",
    logger: createLogger(),
    preferences: fixture.preferences,
    readPersistedMode: async () => false,
    showMessageBox(options) {
      dialogs.push(options);
      return Promise.resolve({ response: 1 });
    }
  });

  fixture.sync({ "lab.fusionMode": false });
  await flushAsyncWork();
  fixture.sync({ "lab.fusionMode": false, "lab.workbenchShortcuts": true });
  await flushAsyncWork();

  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0]?.message, "关闭 Fusion Mode？");
  assert.deepEqual(dialogs[0]?.buttons, ["立即重启", "稍后"]);
  coordinator.dispose();
});

test("Fusion mode restart prompt uses the focused window or a visible fallback", () => {
  const hidden = createPromptWindow({ visible: false });
  const visible = createPromptWindow({ visible: true });
  const focused = createPromptWindow({ visible: true });

  assert.equal(
    resolveFusionModeRestartPromptOwner(focused, [hidden, visible]),
    focused
  );
  assert.equal(
    resolveFusionModeRestartPromptOwner(null, [hidden, visible]),
    visible
  );
  assert.equal(
    resolveFusionModeRestartPromptOwner(
      createPromptWindow({ destroyed: true, visible: true }),
      [hidden]
    ),
    null
  );
});

function createPreferencesFixture(initialFlags: DesktopFeatureFlags) {
  let flags = initialFlags;
  const listeners = new Set<() => void>();
  return {
    preferences: {
      getFeatureFlags: () => flags,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    },
    sync(nextFlags: DesktopFeatureFlags) {
      flags = nextFlags;
      for (const listener of listeners) {
        listener();
      }
    }
  };
}

function createLogger() {
  return {
    info() {},
    warn() {}
  };
}

function createPromptWindow(options: {
  destroyed?: boolean;
  visible: boolean;
}): BrowserWindow {
  return {
    isDestroyed: () => options.destroyed === true,
    isVisible: () => options.visible
  } as unknown as BrowserWindow;
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
