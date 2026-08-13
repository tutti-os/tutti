import assert from "node:assert/strict";
import test from "node:test";
import type { ProgressInfo } from "electron-updater";
import type { UpdateDownloadedEvent, UpdateInfo } from "electron-updater";
import type { DesktopUpdateDevelopmentScenario } from "@tutti-os/desktop-update-admission/development";
import {
  createAppUpdateService,
  createElectronAppUpdateDriver,
  createElectronUpdaterLogger
} from "./appUpdateService.ts";

test("createAppUpdateService can enable dev updates with an injected current version", async () => {
  const driver = createFakeDriver();
  const scenario = createDevelopmentScenario();

  const service = createAppUpdateService(driver, {
    currentVersion: scenario.currentVersion,
    developmentScenario: scenario
  });
  try {
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
        channel: "rc"
      }
    ]);
  } finally {
    service.dispose();
  }
});

test("createAppUpdateService can simulate a dev prerelease update", async () => {
  const scenario = createDevelopmentScenario();
  const service = createAppUpdateService(undefined, {
    currentVersion: scenario.currentVersion,
    developmentScenario: scenario
  });

  try {
    await service.configure({
      channel: "rc",
      policy: "prompt"
    });
    const state = await service.checkForUpdates();

    assert.equal(state.currentVersion, "0.2.0-rc.0");
    assert.equal(state.latestVersion, "0.2.0-rc.1");
    assert.equal(state.status, "available");
  } finally {
    service.dispose();
  }
});

test("store-managed updates never configure or invoke the direct updater", async () => {
  const driver = createFakeDriver();
  const service = createAppUpdateService(driver, {
    currentVersion: "1.2.3",
    releaseFeedResolver: async () => {
      throw new Error("Store builds must not resolve a direct release feed");
    },
    supportsUpdates: false,
    unsupportedMessage: "Updates are managed by Microsoft Store."
  });

  try {
    const configured = await service.configure({
      channel: "rc",
      policy: "auto"
    });
    const checked = await service.checkForUpdates();
    const downloaded = await service.downloadUpdate();
    await service.installUpdate();

    assert.equal(configured.status, "unsupported");
    assert.equal(checked.status, "unsupported");
    assert.equal(downloaded.status, "unsupported");
    assert.deepEqual(driver.configureCalls, []);
  } finally {
    service.dispose();
  }
});

test("mandatory update sessions exclusively own and restore the updater", async () => {
  let checkCalls = 0;
  const driver = createFakeDriver({
    async checkForUpdates() {
      checkCalls += 1;
    }
  });
  const service = createAppUpdateService(driver, { supportsUpdates: true });

  try {
    await service.configure({ channel: "stable", policy: "auto" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const checksAfterNormalConfigure = checkCalls;
    const session = await service.acquireMandatorySession({
      channel: "rc",
      minimumVersion: "2.0.0-rc.1",
      policyRevision: "revision-1"
    });

    await session.prepare();
    assert.equal(
      checkCalls,
      checksAfterNormalConfigure + 1,
      "mandatory prepare owns exactly one update check"
    );
    await assert.rejects(
      service.checkForUpdates(),
      /owned by the mandatory update session/
    );
    await assert.rejects(
      service.acquireMandatorySession({
        channel: "stable",
        minimumVersion: "2.0.0",
        policyRevision: "revision-2"
      }),
      /already active/
    );

    await session.release();
    await waitFor(
      () => checkCalls === checksAfterNormalConfigure + 2,
      "normal updater check did not resume after mandatory session release"
    );
    assert.equal(service.getState().channel, "stable");
    assert.equal(service.getState().policy, "auto");
    assert.equal(checkCalls, checksAfterNormalConfigure + 2);
    await assert.rejects(session.prepare(), /no longer active/);
  } finally {
    service.dispose();
  }
});

test("createElectronAppUpdateDriver keeps downgrade checks disabled after setting channel", () => {
  const updater = createFakeElectronUpdater();
  const driver = createElectronAppUpdateDriver(updater as never);

  driver.configure({
    allowPrerelease: true,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: "rc"
  });

  assert.equal(updater.channel, "rc");
  assert.equal(updater.allowDowngrade, false);
  driver.setFeedUrl("https://updates.example.test/v1.2.3-rc.0");
  assert.deepEqual(updater.feedUrls, [
    "https://updates.example.test/v1.2.3-rc.0"
  ]);
});

test("createAppUpdateService configures the static RC feed before checking", async () => {
  const calls: string[] = [];
  const driver = createFakeDriver({
    checkForUpdates: async () => {
      calls.push("check");
    },
    setFeedUrl(url) {
      calls.push(`feed:${url}`);
    }
  });
  let service: ReturnType<typeof createAppUpdateService> | null = null;

  try {
    service = createAppUpdateService(driver, {
      currentVersion: "0.0.1-rc.16",
      releaseFeedResolver: async ({ channel }) => {
        calls.push(`resolve:${channel}`);
        return {
          feedUrl: "https://updates.example.test/v0.0.1-rc.17",
          releasedAt: "2026-06-15T00:00:00.000Z",
          tag: "v0.0.1-rc.17",
          updaterChannel: "rc",
          version: "0.0.1-rc.17"
        };
      },
      supportsUpdates: true
    });
    await service.configure({
      channel: "rc",
      policy: "prompt"
    });
    await service.checkForUpdates();

    assert.deepEqual(calls, [
      "resolve:rc",
      "feed:https://updates.example.test/v0.0.1-rc.17",
      "check"
    ]);
  } finally {
    service?.dispose();
  }
});

test("createAppUpdateService reports static feed resolution errors", async () => {
  const driver = createFakeDriver();
  const service = createAppUpdateService(driver, {
    releaseFeedResolver: async () => {
      throw new Error("Desktop update pointer channel mismatch");
    },
    supportsUpdates: true
  });

  try {
    await service.configure({ channel: "rc", policy: "prompt" });
    await assert.rejects(
      service.checkForUpdates(),
      /Desktop update pointer channel mismatch/
    );

    assert.equal(service.getState().status, "error");
    assert.deepEqual(driver.feedUrls, []);
  } finally {
    service.dispose();
  }
});

test("createAppUpdateService records native check failures", async () => {
  const driver = createFakeDriver({
    checkForUpdates: async () => {
      throw new Error("Update feed connection closed");
    }
  });
  const service = createAppUpdateService(driver, {
    supportsUpdates: true
  });

  try {
    await service.configure({ channel: "stable", policy: "prompt" });
    await waitFor(
      () => service.getState().status === "error",
      "native update check failure did not update service state"
    );

    assert.equal(service.getState().message, "Update feed connection closed");
  } finally {
    service.dispose();
  }
});

test("createAppUpdateService records download promise failures", async () => {
  const listeners: {
    available?: (info: UpdateInfo) => void;
  } = {};
  const driver = createFakeDriver({
    async downloadUpdate() {
      throw new Error("Differential download connection closed");
    },
    onUpdateAvailable(listener) {
      listeners.available = listener;
      return noop;
    }
  });
  const service = createAppUpdateService(driver, {
    supportsUpdates: true
  });

  try {
    await service.configure({ channel: "stable", policy: "prompt" });
    listeners.available?.(createUpdateInfoFixture("1.1.0"));

    await assert.rejects(
      service.downloadUpdate(),
      /Differential download connection closed/
    );
    assert.equal(service.getState().status, "error");
    assert.equal(
      service.getState().message,
      "Differential download connection closed"
    );
  } finally {
    service.dispose();
  }
});

test("createAppUpdateService shares static feed resolution across concurrent checks", async () => {
  const driver = createFakeDriver();
  const deferredFeed = createDeferred<{
    feedUrl: string;
    releasedAt: string;
    tag: string;
    updaterChannel: "latest" | "rc";
    version: string;
  }>();
  let resolveCalls = 0;
  const service = createAppUpdateService(driver, {
    releaseFeedResolver: () => {
      resolveCalls += 1;
      return deferredFeed.promise;
    },
    supportsUpdates: true
  });

  try {
    await service.configure({ channel: "rc", policy: "prompt" });
    const firstCheck = service.checkForUpdates();
    const secondCheck = service.checkForUpdates();
    assert.equal(resolveCalls, 1);

    deferredFeed.resolve({
      feedUrl: "https://updates.example.test/v0.0.1-rc.17",
      releasedAt: "2026-06-15T00:00:00.000Z",
      tag: "v0.0.1-rc.17",
      updaterChannel: "rc",
      version: "0.0.1-rc.17"
    });
    await Promise.all([firstCheck, secondCheck]);

    assert.deepEqual(driver.feedUrls, [
      "https://updates.example.test/v0.0.1-rc.17"
    ]);
  } finally {
    service.dispose();
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

test("createElectronUpdaterLogger records updater errors", () => {
  const calls: Array<{ level: string; message: string }> = [];
  const logger = createElectronUpdaterLogger({
    logger: {
      debug: (message) => calls.push({ level: "debug", message }),
      error: (message) => calls.push({ level: "error", message }),
      info: (message) => calls.push({ level: "info", message }),
      warn: (message) => calls.push({ level: "warn", message })
    }
  });

  logger.error(new Error("Generic updater request failed"));

  assert.deepEqual(calls, [
    {
      level: "error",
      message: "electron updater error"
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

function createDevelopmentScenario(): DesktopUpdateDevelopmentScenario {
  return {
    currentVersion: "0.2.0-rc.0",
    mockServerUrl: null,
    transport: "in-process",
    updater: {
      check: "available",
      download: "success",
      install: "simulated",
      latestVersion: "0.2.0-rc.1"
    }
  };
}

type DriverConfigureCall = {
  allowPrerelease: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel: string;
};

function createFakeDriver(
  overrides: Partial<Parameters<typeof createAppUpdateService>[0]> = {}
): Parameters<typeof createAppUpdateService>[0] & {
  configureCalls: DriverConfigureCall[];
  emitError(error: Error): void;
  feedUrls: string[];
} {
  const configureCalls: DriverConfigureCall[] = [];
  const errorListeners = new Set<(error: Error) => void>();
  const feedUrls: string[] = [];
  return {
    configureCalls,
    emitError(error) {
      for (const listener of errorListeners) {
        listener(error);
      }
    },
    feedUrls,
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
    setFeedUrl(url) {
      feedUrls.push(url);
    },
    ...overrides
  };
}

function noop() {}

async function waitFor(
  predicate: () => boolean,
  failureMessage: string
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail(failureMessage);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve(value) {
      if (!resolve) {
        throw new Error("Deferred promise was not initialized");
      }
      resolve(value);
    }
  };
}

function createFakeElectronUpdater() {
  let channel: string | null = null;
  const feedUrls: string[] = [];
  return {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    feedUrls,
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
    removeListener() {},
    setFeedURL(options: { url: string }) {
      feedUrls.push(options.url);
    }
  };
}
