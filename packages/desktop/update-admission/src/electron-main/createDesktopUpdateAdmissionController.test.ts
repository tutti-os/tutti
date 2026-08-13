import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type {
  DesktopUpdateAdmissionBackend,
  DesktopUpdateAdmissionSnapshot,
  MinimumVersionAppUpdateService
} from "../contracts/index.ts";
import { createDesktopUpdateAdmissionController } from "./createDesktopUpdateAdmissionController.ts";

function allowedSnapshot(): DesktopUpdateAdmissionSnapshot<"tutti-desktop"> {
  const platform =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : "linux";
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  return {
    featureAvailability: {
      fetchedAt: "2026-08-02T09:00:00Z",
      keys: ["workspace.example"],
      policyRevision: "v1",
      source: "cache"
    },
    identity: {
      architecture,
      currentVersion: "1.0.0",
      platform,
      product: "tutti-desktop"
    },
    lastAttemptAt: "2026-08-02T09:00:00Z",
    nextForegroundCheckAt: "2026-08-02T09:30:00Z",
    policy: {
      response: {
        channel: "stable",
        decision: "allowed",
        minimumVersion: "1.0.0",
        policyRevision: "v1",
        reason: "meetsMinimum"
      },
      status: "resolved"
    }
  };
}

function upgradeRequiredSnapshot(): DesktopUpdateAdmissionSnapshot<"tutti-desktop"> {
  const snapshot = allowedSnapshot();
  return {
    ...snapshot,
    identity: {
      ...snapshot.identity,
      currentVersion: "0.9.0"
    },
    policy: {
      response: {
        channel: "stable",
        decision: "upgradeRequired",
        minimumVersion: "1.0.0",
        policyRevision: "v1",
        reason: "belowMinimum"
      },
      status: "resolved"
    }
  };
}

function failedOpenSnapshot(): DesktopUpdateAdmissionSnapshot<"tutti-desktop"> {
  const snapshot = upgradeRequiredSnapshot();
  return {
    ...snapshot,
    nextForegroundCheckAt: null,
    policy: {
      failure: { kind: "timeout" },
      status: "failedOpen"
    }
  };
}

function updateService(): MinimumVersionAppUpdateService {
  return {
    async acquireMandatorySession() {
      throw new Error("not used");
    },
    getState() {
      return {
        channel: "stable",
        checkedAt: null,
        currentVersion: "1.0.0",
        downloadedBytes: null,
        downloadPercent: null,
        latestVersion: null,
        message: null,
        policy: "prompt",
        releaseDate: null,
        releaseName: null,
        releaseNotesUrl: null,
        status: "idle",
        totalBytes: null
      };
    },
    subscribe() {
      return () => undefined;
    }
  };
}

test("controller consumes daemon startup and foreground snapshots without owning timing", async () => {
  const app = new EventEmitter();
  const snapshot = allowedSnapshot();
  const calls: string[] = [];
  const backend: DesktopUpdateAdmissionBackend<"tutti-desktop"> = {
    async getStartupSnapshot() {
      calls.push("startup");
      return snapshot;
    },
    async refresh(trigger) {
      calls.push(trigger);
      return {
        performed: false,
        skipReason: "throttled",
        snapshot
      };
    }
  };
  const featureSnapshots: DesktopUpdateAdmissionSnapshot<"tutti-desktop">[] =
    [];
  const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const controller = createDesktopUpdateAdmissionController({
    backend,
    electron: {
      app: app as never,
      BrowserWindow: class {
        constructor() {
          throw new Error("allowed policy must not open an upgrade window");
        }
      } as never,
      ipcMain: {
        handle(channel: string, handler: (...args: unknown[]) => unknown) {
          registeredHandlers.set(channel, handler);
        },
        removeHandler(channel: string) {
          registeredHandlers.delete(channel);
        }
      } as never,
      shell: { openExternal: async () => undefined } as never
    },
    featureAvailability: {
      acceptDaemonSnapshot(value) {
        featureSnapshots.push(value);
      }
    },
    listBusinessWindows: () => [],
    logger: { error() {}, info() {} },
    manualDownloadUrl: () => "https://tutti.sh/desktop/download",
    onPolicyReleased() {},
    preloadPath: "/preload.cjs",
    product: "tutti-desktop",
    rendererFilePath: "/minimum-version.html",
    runtime: {
      checksEnabled: true,
      currentVersion: "1.0.0",
      development: true
    },
    updateService: updateService()
  });

  assert.equal(await controller.runStartupCheck(), false);
  await controller.checkAfterForegroundRestore();
  assert.deepEqual(calls, ["startup", "foreground"]);
  assert.equal(featureSnapshots.length, 2);
  controller.dispose();
  assert.equal(registeredHandlers.size, 0);
});

test("startup admission opens a modal upgrade window over the visible business window", async () => {
  const app = new EventEmitter();
  const snapshot = upgradeRequiredSnapshot();
  let businessWindowHidden = false;
  let upgradeWindowCreated = false;
  const upgradeWindowOptions: Array<Record<string, unknown>> = [];
  const businessWindow = {
    focus() {},
    hide() {
      businessWindowHidden = true;
    },
    isDestroyed: () => false,
    isFocused: () => true,
    isMinimized: () => false,
    isVisible: () => true,
    minimize() {},
    show() {}
  };
  class UpgradeWindow {
    public readonly webContents = {
      id: 1,
      send() {},
      setWindowOpenHandler() {},
      on() {}
    };

    public constructor(options: Record<string, unknown>) {
      upgradeWindowCreated = true;
      upgradeWindowOptions.push(options);
    }

    public destroy() {}
    public focus() {}
    public isDestroyed() {
      return false;
    }
    public isFocused() {
      return false;
    }
    public isMinimized() {
      return false;
    }
    public isVisible() {
      return false;
    }
    public loadFile() {
      return Promise.resolve();
    }
    public loadURL() {
      return Promise.resolve();
    }
    public minimize() {}
    public on() {}
    public once() {}
    public show() {}
  }
  const controller = createDesktopUpdateAdmissionController({
    backend: {
      async getStartupSnapshot() {
        return snapshot;
      },
      async refresh() {
        return { performed: false, skipReason: "throttled", snapshot };
      }
    },
    electron: {
      app: app as never,
      BrowserWindow: UpgradeWindow as never,
      ipcMain: {
        handle() {},
        removeHandler() {}
      } as never,
      shell: { openExternal: async () => undefined } as never
    },
    listBusinessWindows: () => [businessWindow as never],
    logger: { error() {}, info() {} },
    manualDownloadUrl: () => "https://tutti.sh/desktop/download",
    onPolicyReleased() {},
    preloadPath: "/preload.cjs",
    product: "tutti-desktop",
    rendererFilePath: "/minimum-version.html",
    runtime: {
      checksEnabled: true,
      currentVersion: "0.9.0",
      development: true
    },
    updateService: updateService()
  });

  assert.equal(await controller.runStartupCheck(), true);
  assert.equal(businessWindowHidden, false);
  assert.equal(upgradeWindowCreated, true);
  assert.equal(upgradeWindowOptions[0]?.modal, true);
  assert.equal(upgradeWindowOptions[0]?.parent, businessWindow);
  controller.dispose();
});

test("foreground admission retries a failed-open check after network recovery", async () => {
  const app = new EventEmitter();
  const failedSnapshot = failedOpenSnapshot();
  const recoveredSnapshot = upgradeRequiredSnapshot();
  const calls: string[] = [];
  let resolveUpgradeWindowCreated: (() => void) | undefined;
  const upgradeWindowCreated = new Promise<void>((resolve) => {
    resolveUpgradeWindowCreated = resolve;
  });
  const businessWindow = {
    isDestroyed: () => false,
    isFocused: () => true,
    isVisible: () => true
  };
  class UpgradeWindow {
    public readonly webContents = {
      id: 1,
      send() {},
      setWindowOpenHandler() {},
      on() {}
    };

    public constructor() {
      resolveUpgradeWindowCreated?.();
    }

    public destroy() {}
    public focus() {}
    public isDestroyed() {
      return false;
    }
    public loadFile() {
      return Promise.resolve();
    }
    public loadURL() {
      return Promise.resolve();
    }
    public on() {}
    public once() {}
    public show() {}
  }
  const controller = createDesktopUpdateAdmissionController({
    backend: {
      async getStartupSnapshot() {
        return failedSnapshot;
      },
      async refresh(trigger) {
        calls.push(trigger);
        return {
          performed: true,
          snapshot: calls.length === 1 ? failedSnapshot : recoveredSnapshot
        };
      }
    },
    electron: {
      app: app as never,
      BrowserWindow: UpgradeWindow as never,
      ipcMain: {
        handle() {},
        removeHandler() {}
      } as never,
      shell: { openExternal: async () => undefined } as never
    },
    foregroundFailureRetryDelayMs: 1,
    listBusinessWindows: () => [businessWindow as never],
    logger: { error() {}, info() {} },
    manualDownloadUrl: () => "https://tutti.sh/desktop/download",
    onPolicyReleased() {},
    preloadPath: "/preload.cjs",
    product: "tutti-desktop",
    rendererFilePath: "/minimum-version.html",
    runtime: {
      checksEnabled: true,
      currentVersion: "0.9.0",
      development: true
    },
    updateService: updateService()
  });

  await controller.checkAfterForegroundRestore();
  await Promise.race([
    upgradeWindowCreated,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("upgrade window was not created")), 500)
    )
  ]);

  assert.deepEqual(calls, ["foreground", "retry"]);
  controller.dispose();
});
