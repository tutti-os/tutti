import assert from "node:assert/strict";
import test from "node:test";
import type { ProgressInfo } from "electron-updater";
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

test("createAppUpdateService refreshes update availability before downloading", async () => {
  const listeners: {
    checking?: () => void;
    available?: (info: UpdateInfo) => void;
    downloaded?: (info: UpdateDownloadedEvent) => void;
  } = {};
  const emittedStatuses: string[] = [];
  let checkCallCount = 0;
  let emitFreshAvailability = false;
  let latestAvailableVersion = "1.1.0";
  let downloadedVersion: string | null = null;
  const driver = createFakeDriver({
    async checkForUpdates() {
      checkCallCount += 1;
      listeners.checking?.();
      if (!emitFreshAvailability) {
        return;
      }
      latestAvailableVersion = "1.2.0";
      listeners.available?.(createUpdateInfoFixture(latestAvailableVersion));
    },
    async downloadUpdate() {
      downloadedVersion = latestAvailableVersion;
      listeners.downloaded?.(
        createUpdateDownloadedInfoFixture(latestAvailableVersion)
      );
    },
    onUpdateAvailable(listener) {
      listeners.available = listener;
      return noop;
    },
    onCheckingForUpdate(listener) {
      listeners.checking = listener;
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
    await service.checkForUpdates();
    listeners.available?.(createUpdateInfoFixture("1.1.0"));
    emittedStatuses.length = 0;

    const checksBeforeDownload = checkCallCount;
    emitFreshAvailability = true;
    const state = await service.downloadUpdate();

    assert.equal(checkCallCount, checksBeforeDownload + 1);
    assert.equal(downloadedVersion, "1.2.0");
    assert.equal(state.latestVersion, "1.2.0");
    assert.equal(state.status, "downloaded");
    assert.deepEqual(emittedStatuses, ["available", "downloaded"]);
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

test("createAppUpdateService marks update install pending before quitAndInstall", async () => {
  const events: string[] = [];
  const listeners: {
    available?: (info: UpdateInfo) => void;
    downloaded?: (info: UpdateDownloadedEvent) => void;
  } = {};
  const driver = createFakeDriver({
    async downloadUpdate() {
      listeners.downloaded?.(createUpdateDownloadedInfoFixture("1.1.0"));
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
  let quitAndInstallCalls = 0;
  driver.quitAndInstall = () => {
    quitAndInstallCalls += 1;
    events.push(
      `quit-and-install:pending:${service.isQuitAndInstallPending()}`
    );
  };
  const service = createAppUpdateService(driver, {
    supportsUpdates: true
  });

  try {
    await service.configure({
      channel: "stable",
      policy: "prompt"
    });
    listeners.available?.(createUpdateInfoFixture("1.1.0"));
    await service.downloadUpdate();
    assert.equal(service.getState().status, "downloaded");

    await service.installUpdate();

    assert.deepEqual(events, ["quit-and-install:pending:true"]);
    assert.equal(quitAndInstallCalls, 1);
    assert.equal(service.isQuitAndInstallPending(), true);
  } finally {
    service.dispose();
  }
});

test("createAppUpdateService ignores duplicate install requests while quitAndInstall is pending", async () => {
  const events: string[] = [];
  const listeners: {
    available?: (info: UpdateInfo) => void;
    downloaded?: (info: UpdateDownloadedEvent) => void;
  } = {};
  const driver = createFakeDriver({
    async downloadUpdate() {
      listeners.downloaded?.(createUpdateDownloadedInfoFixture("1.1.0"));
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
  driver.quitAndInstall = () => {
    events.push("updater:quit-and-install");
  };
  const service = createAppUpdateService(driver, {
    supportsUpdates: true
  });

  try {
    await service.configure({
      channel: "stable",
      policy: "prompt"
    });
    listeners.available?.(createUpdateInfoFixture("1.1.0"));
    await service.downloadUpdate();

    const firstInstall = service.installUpdate();
    const secondInstall = service.installUpdate();
    await Promise.resolve();

    assert.equal(service.isQuitAndInstallPending(), true);
    assert.deepEqual(events, ["updater:quit-and-install"]);
    await Promise.all([firstInstall, secondInstall]);

    assert.deepEqual(events, ["updater:quit-and-install"]);
  } finally {
    service.dispose();
  }
});

test("createAppUpdateService clears pending install when quitAndInstall emits an updater error", async () => {
  const events: string[] = [];
  const listeners: {
    available?: (info: UpdateInfo) => void;
    downloaded?: (info: UpdateDownloadedEvent) => void;
  } = {};
  const driver = createFakeDriver({
    async downloadUpdate() {
      listeners.downloaded?.(createUpdateDownloadedInfoFixture("1.1.0"));
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
  driver.quitAndInstall = () => {
    events.push("updater:quit-and-install");
  };
  const service = createAppUpdateService(driver, {
    supportsUpdates: true
  });

  try {
    await service.configure({
      channel: "stable",
      policy: "prompt"
    });
    listeners.available?.(createUpdateInfoFixture("1.1.0"));
    await service.downloadUpdate();

    await service.installUpdate();
    assert.equal(service.isQuitAndInstallPending(), true);

    driver.emitError(new Error("Squirrel failed to install update"));
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(service.isQuitAndInstallPending(), false);
    assert.equal(service.getState().status, "error");
    assert.deepEqual(events, ["updater:quit-and-install"]);
  } finally {
    service.dispose();
  }
});

test("createAppUpdateService clears pending install when quitAndInstall throws synchronously", async () => {
  const events: string[] = [];
  const listeners: {
    available?: (info: UpdateInfo) => void;
    downloaded?: (info: UpdateDownloadedEvent) => void;
  } = {};
  const driver = createFakeDriver({
    async downloadUpdate() {
      listeners.downloaded?.(createUpdateDownloadedInfoFixture("1.1.0"));
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
  driver.quitAndInstall = () => {
    events.push("updater:quit-and-install");
    throw new Error("native quit failed");
  };
  const service = createAppUpdateService(driver, {
    supportsUpdates: true
  });

  try {
    await service.configure({
      channel: "stable",
      policy: "prompt"
    });
    listeners.available?.(createUpdateInfoFixture("1.1.0"));
    await service.downloadUpdate();

    await assert.rejects(service.installUpdate(), /native quit failed/);

    assert.equal(service.isQuitAndInstallPending(), false);
    assert.equal(service.getState().status, "error");
    assert.deepEqual(events, ["updater:quit-and-install"]);
  } finally {
    service.dispose();
  }
});

test("createAppUpdateService skips identical consecutive download progress states", async () => {
  const progressListeners = new Set<(progress: ProgressInfo) => void>();
  let stateChangeCount = 0;
  const driver = createFakeDriver({
    onDownloadProgress(listener) {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    }
  });
  const service = createAppUpdateService(driver, {
    supportsUpdates: true
  });

  try {
    service.onStateChanged(() => {
      stateChangeCount += 1;
    });
    await service.configure({
      channel: "stable",
      policy: "prompt"
    });

    const progress: ProgressInfo = {
      bytesPerSecond: 1_000,
      delta: 100,
      percent: 10,
      total: 1_000,
      transferred: 100
    };
    for (const listener of progressListeners) {
      listener(progress);
    }
    stateChangeCount = 0;

    for (const listener of progressListeners) {
      listener(progress);
      listener(progress);
    }
    assert.equal(stateChangeCount, 0);

    const nextProgress: ProgressInfo = {
      ...progress,
      delta: 100,
      percent: 20,
      transferred: 200
    };
    for (const listener of progressListeners) {
      listener(nextProgress);
    }
    assert.equal(stateChangeCount, 1);
  } finally {
    service.dispose();
  }
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
