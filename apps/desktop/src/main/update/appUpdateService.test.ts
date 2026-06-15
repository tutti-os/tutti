import assert from "node:assert/strict";
import test from "node:test";
import type { UpdateDownloadedEvent, UpdateInfo } from "electron-updater";
import {
  createAppUpdateService,
  createElectronAppUpdateDriver,
  createElectronUpdaterLogger
} from "./appUpdateService.ts";

test("createAppUpdateService can enable dev updates with an injected current version", async () => {
  const env = withAppUpdateEnv({
    TUTTI_APP_UPDATE_CURRENT_VERSION: "0.2.0-rc.0",
    TUTTI_APP_UPDATE_DEV: "1"
  });
  const driver = createFakeDriver();

  try {
    const service = createAppUpdateService(driver, {
      supportsUpdates: undefined
    });
    const state = await service.configure({
      channel: "rc",
      policy: "auto"
    });

    assert.equal(state.currentVersion, "0.2.0-rc.0");
    assert.equal(state.status, "idle");
    assert.deepEqual(driver.configureCalls, [
      {
        allowPrerelease: true,
        autoDownload: true,
        autoInstallOnAppQuit: true,
        channel: "rc",
        forceDevUpdateConfig: true
      }
    ]);
    service.dispose();
  } finally {
    env.restore();
  }
});

test("createAppUpdateService can simulate a dev prerelease update", async () => {
  const env = withAppUpdateEnv({
    TUTTI_APP_UPDATE_CURRENT_VERSION: "0.2.0-rc.0",
    TUTTI_APP_UPDATE_DEV: "1",
    TUTTI_APP_UPDATE_LATEST_VERSION: "0.2.0-rc.1",
    TUTTI_APP_UPDATE_MOCK: "available"
  });

  try {
    const service = createAppUpdateService();
    await service.configure({
      channel: "rc",
      policy: "prompt"
    });
    const state = await service.checkForUpdates();

    assert.equal(state.currentVersion, "0.2.0-rc.0");
    assert.equal(state.latestVersion, "0.2.0-rc.1");
    assert.equal(state.status, "available");
    service.dispose();
  } finally {
    env.restore();
  }
});

test("createElectronAppUpdateDriver keeps downgrade checks disabled after setting channel", () => {
  const updater = createFakeElectronUpdater();
  const driver = createElectronAppUpdateDriver(updater as never, {
    shouldSuppressNoPublishedVersionsError: () => false
  });

  driver.configure({
    allowPrerelease: true,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: "rc",
    forceDevUpdateConfig: true
  });

  assert.equal(updater.channel, "rc");
  assert.equal(updater.allowDowngrade, false);
});

test("createAppUpdateService recognizes prefixed GitHub rc release tags", async () => {
  const env = withAppUpdateEnv({
    TUTTI_APP_UPDATE_CURRENT_VERSION: "0.0.1-rc.16",
    TUTTI_APP_UPDATE_DEV: "1"
  });
  const driver = createFakeDriver({
    checkForUpdates: async () => {
      driver.emitError(new Error("No published versions on GitHub"));
      throw new Error("No published versions on GitHub");
    }
  });
  const emittedStatuses: string[] = [];
  let service: ReturnType<typeof createAppUpdateService> | null = null;

  try {
    service = createAppUpdateService(driver, {
      prefixedReleaseResolver: async () => ({
        htmlUrl:
          "https://github.com/tutti-os/tutti/releases/tag/tutti-desktop-v0.0.1-rc.17",
        name: "tutti-desktop-v0.0.1-rc.17",
        publishedAt: "2026-06-15T00:00:00.000Z",
        tagName: "tutti-desktop-v0.0.1-rc.17",
        version: "0.0.1-rc.17"
      }),
      supportsUpdates: true
    });
    service.onStateChanged((state) => {
      emittedStatuses.push(state.status);
    });
    await service.configure({
      channel: "rc",
      policy: "prompt"
    });
    const state = await service.checkForUpdates();

    assert.equal(state.currentVersion, "0.0.1-rc.16");
    assert.equal(state.latestVersion, "0.0.1-rc.17");
    assert.equal(state.releaseName, "tutti-desktop-v0.0.1-rc.17");
    assert.equal(
      state.releaseNotesUrl,
      "https://github.com/tutti-os/tutti/releases/tag/tutti-desktop-v0.0.1-rc.17"
    );
    assert.equal(state.status, "available");
    assert.ok(!emittedStatuses.includes("error"));
  } finally {
    service?.dispose();
    env.restore();
  }
});

test("createAppUpdateService skips downloading state when cached update is already downloaded", async () => {
  const listeners: {
    available?: (info: UpdateInfo) => void;
    downloaded?: (info: UpdateDownloadedEvent) => void;
  } = {};
  const emittedStatuses: string[] = [];
  const updateInfo = createUpdateInfoFixture("1.1.0");
  const downloadedInfo = createUpdateDownloadedInfoFixture("1.1.0");
  const driver = createFakeDriver({
    async downloadUpdate() {
      listeners.downloaded?.(downloadedInfo);
    },
    onUpdateAvailable(listener) {
      listeners.available = listener;
      return noop;
    },
    onUpdateDownloaded(listener) {
      listeners.downloaded = listener;
      return noop;
    }
  });
  const service = createAppUpdateService(driver, {
    supportsUpdates: true
  });

  try {
    service.onStateChanged((state) => {
      emittedStatuses.push(state.status);
    });
    await service.configure({
      channel: "stable",
      policy: "prompt"
    });
    listeners.available?.(updateInfo);
    emittedStatuses.length = 0;

    const state = await service.downloadUpdate();

    assert.equal(state.status, "downloaded");
    assert.deepEqual(emittedStatuses, ["downloaded"]);
  } finally {
    service.dispose();
  }
});

test("createElectronUpdaterLogger defers no published versions errors during prefixed fallback", () => {
  const calls: Array<{ level: string; message: string }> = [];
  const logger = createElectronUpdaterLogger({
    logger: {
      debug: (message) => calls.push({ level: "debug", message }),
      error: (message) => calls.push({ level: "error", message }),
      info: (message) => calls.push({ level: "info", message }),
      warn: (message) => calls.push({ level: "warn", message })
    },
    shouldSuppressNoPublishedVersionsError: () => true
  });

  logger.error(new Error("No published versions on GitHub"));

  assert.deepEqual(calls, [
    {
      level: "info",
      message:
        "electron updater error deferred for prefixed GitHub release fallback"
    }
  ]);
});

function createUpdateInfoFixture(version: string): UpdateInfo {
  return {
    files: [],
    path: "",
    releaseDate: "2026-06-15T00:00:00.000Z",
    releaseName: version,
    sha512: "",
    version
  };
}

function createUpdateDownloadedInfoFixture(
  version: string
): UpdateDownloadedEvent {
  return {
    ...createUpdateInfoFixture(version),
    downloadedFile: "/tmp/Tutti.zip"
  };
}

function withAppUpdateEnv(values: Record<string, string>): {
  restore(): void;
} {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  return {
    restore() {
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  };
}

type DriverConfigureCall = {
  allowPrerelease: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel: string;
  forceDevUpdateConfig: boolean;
};

function createFakeDriver(
  overrides: Partial<Parameters<typeof createAppUpdateService>[0]> = {}
): Parameters<typeof createAppUpdateService>[0] & {
  configureCalls: DriverConfigureCall[];
  emitError(error: Error): void;
} {
  const configureCalls: DriverConfigureCall[] = [];
  const errorListeners = new Set<(error: Error) => void>();
  return {
    configureCalls,
    emitError(error) {
      for (const listener of errorListeners) {
        listener(error);
      }
    },
    checkForUpdates: async () => {},
    configure(options) {
      configureCalls.push(options);
    },
    downloadUpdate: async () => {},
    onCheckingForUpdate: () => noop,
    onDownloadProgress: () => noop,
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    onUpdateAvailable: () => noop,
    onUpdateDownloaded: () => noop,
    onUpdateNotAvailable: () => noop,
    quitAndInstall() {},
    ...overrides
  };
}

function noop() {}

function createFakeElectronUpdater() {
  let channel: string | null = null;
  return {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    forceDevUpdateConfig: false,
    logger: null,
    get channel() {
      return channel;
    },
    set channel(value: string | null) {
      channel = value;
      this.allowDowngrade = true;
    },
    checkForUpdates: async () => null,
    downloadUpdate: async () => [],
    on() {},
    quitAndInstall() {},
    removeListener() {}
  };
}
