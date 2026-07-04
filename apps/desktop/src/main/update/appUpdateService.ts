import electron from "electron";
import electronUpdater, {
  type AppUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo
} from "electron-updater";
import { isSameAppUpdateState } from "../../shared/contracts/appUpdateState.ts";
import {
  desktopIpcChannels,
  type AppUpdateChannel,
  type AppUpdatePolicy,
  type AppUpdateState,
  type AppUpdateStatus,
  type ConfigureAppUpdatesInput
} from "../../shared/contracts/ipc.ts";
import { getDesktopLogger, type DesktopLogger } from "../logging.ts";
import {
  resolveMacAppBundlePath,
  resolveMacUpdaterSupport
} from "./macosUpdaterSupport.ts";
import {
  compareDesktopVersions,
  createGitHubPrefixedDesktopReleaseResolver,
  parseDesktopVersion,
  type PrefixedDesktopReleaseResolver
} from "./prefixedDesktopReleaseResolver.ts";

const { app, BrowserWindow } = electron;

const updateCheckIntervalMs = 1000 * 60 * 60 * 3;

type DriverDisposer = () => void;

interface ElectronUpdaterLogger {
  debug?(message?: unknown, ...optionalParams: unknown[]): void;
  error(message?: unknown, ...optionalParams: unknown[]): void;
  info(message?: unknown, ...optionalParams: unknown[]): void;
  warn(message?: unknown, ...optionalParams: unknown[]): void;
}

interface AppUpdateDriver {
  checkForUpdates(): Promise<void>;
  configure(options: {
    allowPrerelease: boolean;
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    channel: string;
    forceDevUpdateConfig: boolean;
  }): void;
  downloadUpdate(): Promise<void>;
  onCheckingForUpdate(listener: () => void): DriverDisposer;
  onDownloadProgress(
    listener: (progress: ProgressInfo) => void
  ): DriverDisposer;
  onError(listener: (error: Error) => void): DriverDisposer;
  onUpdateAvailable(listener: (info: UpdateInfo) => void): DriverDisposer;
  onUpdateDownloaded(
    listener: (info: UpdateDownloadedEvent) => void
  ): DriverDisposer;
  onUpdateNotAvailable(listener: (info: UpdateInfo) => void): DriverDisposer;
  quitAndInstall(): void;
}

export interface AppUpdateService {
  checkForUpdates(): Promise<AppUpdateState>;
  configure(input: ConfigureAppUpdatesInput): Promise<AppUpdateState>;
  dispose(): void;
  downloadUpdate(): Promise<AppUpdateState>;
  getState(): AppUpdateState;
  installUpdate(): Promise<void>;
  isQuitAndInstallPending(): boolean;
  onStateChanged(
    listener: (state: AppUpdateState, previousState: AppUpdateState) => void
  ): () => void;
}

interface AppUpdateServiceOptions {
  prefixedReleaseResolver?: PrefixedDesktopReleaseResolver | null;
  supportsUpdates?: boolean;
  unsupportedMessage?: string;
}

export function createElectronAppUpdateDriver(
  updater: AppUpdater,
  options: {
    shouldSuppressNoPublishedVersionsError(): boolean;
  }
): AppUpdateDriver {
  updater.logger = createElectronUpdaterLogger({
    logger: getDesktopLogger(),
    shouldSuppressNoPublishedVersionsError: () =>
      options.shouldSuppressNoPublishedVersionsError()
  });

  const emitter = updater as unknown as {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    removeListener: (
      event: string,
      listener: (...args: unknown[]) => void
    ) => void;
  };

  const listen = <T>(
    event: string,
    listener: (payload: T) => void
  ): DriverDisposer => {
    const handler = (...args: unknown[]) => {
      listener(args[0] as T);
    };
    emitter.on(event, handler);
    return () => {
      emitter.removeListener(event, handler);
    };
  };

  const listenVoid = (event: string, listener: () => void): DriverDisposer => {
    emitter.on(event, listener);
    return () => {
      emitter.removeListener(event, listener);
    };
  };

  return {
    checkForUpdates: () => updater.checkForUpdates().then(() => undefined),
    configure(options) {
      updater.autoDownload = options.autoDownload;
      updater.autoInstallOnAppQuit = options.autoInstallOnAppQuit;
      updater.allowPrerelease = options.allowPrerelease;
      updater.channel = options.channel;
      updater.allowDowngrade = false;
      updater.forceDevUpdateConfig = options.forceDevUpdateConfig;
    },
    downloadUpdate: () => updater.downloadUpdate().then(() => undefined),
    onCheckingForUpdate: (listener) =>
      listenVoid("checking-for-update", listener),
    onDownloadProgress: (listener) =>
      listen<ProgressInfo>("download-progress", listener),
    onError: (listener) => listen<Error>("error", listener),
    onUpdateAvailable: (listener) =>
      listen<UpdateInfo>("update-available", listener),
    onUpdateDownloaded: (listener) =>
      listen<UpdateDownloadedEvent>("update-downloaded", listener),
    onUpdateNotAvailable: (listener) =>
      listen<UpdateInfo>("update-not-available", listener),
    quitAndInstall: () => {
      updater.quitAndInstall();
    }
  };
}

export function createElectronUpdaterLogger(options: {
  logger: Pick<DesktopLogger, "debug" | "error" | "info" | "warn">;
  shouldSuppressNoPublishedVersionsError(): boolean;
}): ElectronUpdaterLogger {
  const formatArguments = (
    message?: unknown,
    optionalParams: unknown[] = []
  ): string => [message, ...optionalParams].map(formatLogArgument).join(" ");

  return {
    debug(message, ...optionalParams) {
      options.logger.debug("electron updater debug", {
        detail: formatArguments(message, optionalParams)
      });
    },
    error(message, ...optionalParams) {
      if (
        options.shouldSuppressNoPublishedVersionsError() &&
        isNoPublishedVersionsLogArgument(message)
      ) {
        options.logger.info(
          "electron updater error deferred for prefixed GitHub release fallback",
          {
            detail: formatArguments(message, optionalParams)
          }
        );
        return;
      }

      options.logger.error("electron updater error", {
        detail: formatArguments(message, optionalParams)
      });
    },
    info(message, ...optionalParams) {
      options.logger.info("electron updater info", {
        detail: formatArguments(message, optionalParams)
      });
    },
    warn(message, ...optionalParams) {
      options.logger.warn("electron updater warning", {
        detail: formatArguments(message, optionalParams)
      });
    }
  };
}

function buildBaseState(
  currentVersion: string,
  policy: AppUpdatePolicy,
  channel: AppUpdateChannel,
  status: AppUpdateStatus,
  message: string | null = null
): AppUpdateState {
  return {
    channel,
    checkedAt: null,
    currentVersion,
    downloadedBytes: null,
    downloadPercent: null,
    latestVersion: null,
    message,
    policy,
    releaseDate: null,
    releaseName: null,
    releaseNotesUrl: null,
    status,
    totalBytes: null
  };
}

function normalizeReleaseDate(
  value: Date | string | null | undefined
): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function summarizeUpdateErrorMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (normalized.includes("Cannot parse releases feed")) {
    return "Unable to read the update feed from GitHub Releases.";
  }
  if (
    normalized.includes("Code signature at URL") &&
    normalized.includes("did not pass validation")
  ) {
    return "macOS rejected the downloaded update because its code signature did not match this build. Download the latest release manually.";
  }
  if (
    normalized.includes("net::ERR_INTERNET_DISCONNECTED") ||
    normalized.includes("net::ERR_NETWORK_CHANGED")
  ) {
    return "Network connection was interrupted while checking for updates.";
  }

  return normalized.length <= 160
    ? normalized
    : `${normalized.slice(0, 157).trimEnd()}...`;
}

function normalizeMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return summarizeUpdateErrorMessage(error.message);
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return summarizeUpdateErrorMessage(error);
  }

  return "Unknown update error";
}

function formatErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return typeof error === "string" ? error : String(error);
}

function formatLogArgument(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }

  return typeof value === "string" ? value : String(value);
}

function envFlagEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function resolveCurrentVersion(
  appVersion: string,
  isPackaged: boolean
): string {
  const override = process.env.TUTTI_APP_UPDATE_CURRENT_VERSION?.trim();
  if (!isPackaged && override) {
    return override;
  }

  return appVersion;
}

function resolveMockLatestVersion(currentVersion: string): string {
  return (
    process.env.TUTTI_APP_UPDATE_LATEST_VERSION?.trim() ||
    `${currentVersion}-dev-update`
  );
}

function isNoPublishedVersionsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("No published versions on GitHub")
  );
}

function isNoPublishedVersionsLogArgument(value: unknown): boolean {
  return (
    isNoPublishedVersionsError(value) ||
    formatLogArgument(value).includes("No published versions on GitHub")
  );
}

function createDevelopmentMockAppUpdateDriver(
  currentVersion: string
): AppUpdateDriver | null {
  const mode = process.env.TUTTI_APP_UPDATE_MOCK?.trim().toLowerCase();
  if (!mode) {
    return null;
  }

  const checkingListeners = new Set<() => void>();
  const progressListeners = new Set<(progress: ProgressInfo) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  const availableListeners = new Set<(info: UpdateInfo) => void>();
  const downloadedListeners = new Set<(info: UpdateDownloadedEvent) => void>();
  const notAvailableListeners = new Set<(info: UpdateInfo) => void>();

  const latestVersion = resolveMockLatestVersion(currentVersion);
  const updateInfo = (): UpdateInfo => ({
    files: [],
    path: "",
    releaseDate: new Date().toISOString(),
    releaseName: latestVersion,
    sha512: "",
    version: latestVersion
  });

  return {
    checkForUpdates() {
      for (const listener of checkingListeners) {
        listener();
      }
      if (mode === "error") {
        for (const listener of errorListeners) {
          listener(new Error("Mock update check failed."));
        }
        return Promise.resolve();
      }
      if (mode === "up_to_date" || mode === "not_available") {
        const info = updateInfo();
        for (const listener of notAvailableListeners) {
          listener(info);
        }
        return Promise.resolve();
      }

      const info = updateInfo();
      for (const listener of availableListeners) {
        listener(info);
      }
      if (mode === "downloaded") {
        for (const listener of downloadedListeners) {
          listener(info as UpdateDownloadedEvent);
        }
      }
      return Promise.resolve();
    },
    configure() {},
    downloadUpdate() {
      const info = updateInfo();
      for (const listener of progressListeners) {
        listener({
          bytesPerSecond: 0,
          delta: 100,
          percent: 100,
          total: 100,
          transferred: 100
        });
      }
      for (const listener of downloadedListeners) {
        listener(info as UpdateDownloadedEvent);
      }
      return Promise.resolve();
    },
    onCheckingForUpdate(listener) {
      checkingListeners.add(listener);
      return () => checkingListeners.delete(listener);
    },
    onDownloadProgress(listener) {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    onUpdateAvailable(listener) {
      availableListeners.add(listener);
      return () => availableListeners.delete(listener);
    },
    onUpdateDownloaded(listener) {
      downloadedListeners.add(listener);
      return () => downloadedListeners.delete(listener);
    },
    onUpdateNotAvailable(listener) {
      notAvailableListeners.add(listener);
      return () => notAvailableListeners.delete(listener);
    },
    quitAndInstall() {}
  };
}

export function createAppUpdateService(
  driver?: AppUpdateDriver,
  options: AppUpdateServiceOptions = {}
): AppUpdateService {
  const isPackaged = Boolean(app?.isPackaged);
  const devUpdatesEnabled = envFlagEnabled("TUTTI_APP_UPDATE_DEV");
  const appVersion = app?.getVersion?.() ?? "0.0.0";
  const currentVersion = resolveCurrentVersion(appVersion, isPackaged);
  const prefixedReleaseResolver =
    options.prefixedReleaseResolver === undefined
      ? createGitHubPrefixedDesktopReleaseResolver()
      : options.prefixedReleaseResolver;
  let activeCheckCanUsePrefixedFallback = false;
  const resolvedDriver =
    driver ??
    createDevelopmentMockAppUpdateDriver(currentVersion) ??
    createElectronAppUpdateDriver(electronUpdater.autoUpdater, {
      shouldSuppressNoPublishedVersionsError: () =>
        activeCheckCanUsePrefixedFallback
    });
  let supportsUpdates =
    options.supportsUpdates ??
    ((process.env.NODE_ENV !== "test" && isPackaged) || devUpdatesEnabled);
  let unsupportedMessage =
    options.unsupportedMessage ??
    (process.env.NODE_ENV === "test"
      ? "Update checks are disabled in tests."
      : "Update checks are only available in packaged builds.");

  if (
    options.supportsUpdates === undefined &&
    supportsUpdates &&
    isPackaged &&
    process.platform === "darwin"
  ) {
    const macSupport = resolveMacUpdaterSupport({
      appPath: resolveMacAppBundlePath(app.getPath("exe"))
    });
    if (!macSupport.supported) {
      supportsUpdates = false;
      unsupportedMessage = macSupport.message ?? unsupportedMessage;
    }
  }

  let state = buildBaseState(
    currentVersion,
    "prompt",
    "rc",
    supportsUpdates ? "idle" : "unsupported",
    supportsUpdates ? null : unsupportedMessage
  );
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let activeCheckPromise: Promise<void> | null = null;
  let activeDownloadPromise: Promise<void> | null = null;
  let preserveAvailableStateDuringCheck = false;
  let quitAndInstallPending = false;
  const stateChangedListeners = new Set<
    (state: AppUpdateState, previousState: AppUpdateState) => void
  >();

  const emitState = (): void => {
    for (const window of BrowserWindow?.getAllWindows?.() ?? []) {
      window.webContents.send(desktopIpcChannels.update.state, state);
    }
  };

  const applyState = (nextState: AppUpdateState): AppUpdateState => {
    if (isSameAppUpdateState(state, nextState)) {
      return state;
    }

    const previousState = state;
    state = nextState;
    emitState();
    for (const listener of stateChangedListeners) {
      listener(state, previousState);
    }
    return state;
  };

  const clearSchedule = (): void => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const applyUpdaterError = (error: Error): void => {
    getDesktopLogger().error("application updater failed", {
      error: error.message,
      error_name: error.name
    });
    applyState({
      ...buildBaseState(
        currentVersion,
        state.policy,
        state.channel,
        "error",
        normalizeMessage(error)
      ),
      checkedAt: new Date().toISOString(),
      latestVersion: state.latestVersion,
      releaseDate: state.releaseDate,
      releaseName: state.releaseName
    });
  };

  const resetConfiguredState = (
    status: AppUpdateStatus,
    message: string | null = null
  ): void => {
    applyState(
      buildBaseState(
        currentVersion,
        state.policy,
        state.channel,
        status,
        message
      )
    );
  };

  const scheduleChecks = (): void => {
    clearSchedule();
    if (!supportsUpdates || state.policy === "off") {
      return;
    }

    intervalId = setInterval(() => {
      runBackgroundCheck("interval");
    }, updateCheckIntervalMs);
  };

  const driverDisposers = [
    resolvedDriver.onCheckingForUpdate(() => {
      getDesktopLogger().info("checking for application updates", {
        channel: state.channel,
        policy: state.policy
      });
      if (preserveAvailableStateDuringCheck && state.status === "available") {
        return;
      }
      applyState({
        ...buildBaseState(
          currentVersion,
          state.policy,
          state.channel,
          "checking"
        ),
        checkedAt: state.checkedAt
      });
    }),
    resolvedDriver.onUpdateAvailable((info) => {
      getDesktopLogger().info("application update is available", {
        release_date: normalizeReleaseDate(info.releaseDate),
        release_name: info.releaseName ?? null,
        version: info.version ?? null
      });
      applyState({
        ...buildBaseState(
          currentVersion,
          state.policy,
          state.channel,
          "available"
        ),
        checkedAt: new Date().toISOString(),
        latestVersion: info.version ?? null,
        releaseDate: normalizeReleaseDate(info.releaseDate),
        releaseName: info.releaseName ?? null
      });
    }),
    resolvedDriver.onUpdateNotAvailable(() => {
      applyState({
        ...buildBaseState(
          currentVersion,
          state.policy,
          state.channel,
          "up_to_date"
        ),
        checkedAt: new Date().toISOString()
      });
    }),
    resolvedDriver.onDownloadProgress((progress) => {
      applyState({
        ...state,
        downloadedBytes: Number.isFinite(progress.transferred)
          ? progress.transferred
          : null,
        downloadPercent: Number.isFinite(progress.percent)
          ? progress.percent
          : null,
        status: "downloading",
        totalBytes: Number.isFinite(progress.total) ? progress.total : null
      });
    }),
    resolvedDriver.onUpdateDownloaded((info) => {
      applyState({
        ...state,
        checkedAt: new Date().toISOString(),
        downloadedBytes: state.totalBytes,
        downloadPercent: 100,
        latestVersion: info.version ?? state.latestVersion,
        releaseDate:
          normalizeReleaseDate(info.releaseDate) ?? state.releaseDate,
        releaseName: info.releaseName ?? state.releaseName,
        status: "downloaded"
      });
    }),
    resolvedDriver.onError((error) => {
      if (
        activeCheckCanUsePrefixedFallback &&
        isNoPublishedVersionsError(error)
      ) {
        getDesktopLogger().info(
          "application updater error deferred for prefixed GitHub release fallback",
          {
            error: error.message,
            error_name: error.name
          }
        );
        return;
      }

      applyUpdaterError(error);
      quitAndInstallPending = false;
    })
  ];

  const service: AppUpdateService = {
    async checkForUpdates() {
      if (
        !supportsUpdates ||
        state.policy === "off" ||
        state.status === "downloaded"
      ) {
        return state;
      }

      if (activeCheckPromise) {
        await activeCheckPromise;
        return state;
      }

      activeCheckCanUsePrefixedFallback = Boolean(prefixedReleaseResolver);
      activeCheckPromise = resolvedDriver.checkForUpdates().finally(() => {
        activeCheckPromise = null;
        activeCheckCanUsePrefixedFallback = false;
      });
      try {
        await activeCheckPromise;
      } catch (error) {
        const fallbackState = await applyPrefixedReleaseFallback(error);
        if (!fallbackState) {
          throw error;
        }
      }
      return state;
    },
    configure(input) {
      state = {
        ...state,
        channel: input.channel ?? "stable",
        policy: input.policy
      };

      clearSchedule();
      if (!supportsUpdates) {
        return Promise.resolve(
          applyState(
            buildBaseState(
              currentVersion,
              state.policy,
              state.channel,
              "unsupported",
              unsupportedMessage
            )
          )
        );
      }

      if (state.policy === "off") {
        return Promise.resolve(
          applyState(
            buildBaseState(
              currentVersion,
              state.policy,
              state.channel,
              "disabled"
            )
          )
        );
      }

      const updaterChannel = state.channel === "rc" ? "rc" : "latest";
      resolvedDriver.configure({
        allowPrerelease: state.channel === "rc",
        autoDownload: state.policy === "auto",
        autoInstallOnAppQuit: state.policy === "auto",
        channel: updaterChannel,
        forceDevUpdateConfig: devUpdatesEnabled && !isPackaged
      });
      resetConfiguredState("idle");
      scheduleChecks();
      runBackgroundCheck("configure");
      return Promise.resolve(state);
    },
    dispose() {
      clearSchedule();
      for (const dispose of driverDisposers) {
        dispose();
      }
    },
    async downloadUpdate() {
      if (!supportsUpdates) {
        return state;
      }

      if (activeDownloadPromise) {
        await activeDownloadPromise;
        return state;
      }

      if (state.status !== "available") {
        return state;
      }

      preserveAvailableStateDuringCheck = true;
      try {
        await service.checkForUpdates();
      } finally {
        preserveAvailableStateDuringCheck = false;
      }
      if (state.status !== "available") {
        return state;
      }

      activeDownloadPromise = resolvedDriver.downloadUpdate().finally(() => {
        activeDownloadPromise = null;
      });
      await activeDownloadPromise;
      return state;
    },
    getState() {
      getDesktopLogger().info("application update state requested", {
        channel: state.channel,
        current_version: state.currentVersion,
        is_checking: Boolean(activeCheckPromise),
        is_downloading: Boolean(activeDownloadPromise),
        latest_version: state.latestVersion,
        policy: state.policy,
        status: state.status,
        supports_updates: supportsUpdates
      });
      return state;
    },
    async installUpdate() {
      if (state.status !== "downloaded" || quitAndInstallPending) {
        return;
      }

      quitAndInstallPending = true;
      getDesktopLogger().info("application update install requested", {
        channel: state.channel,
        latest_version: state.latestVersion,
        policy: state.policy
      });

      try {
        resolvedDriver.quitAndInstall();
      } catch (error) {
        quitAndInstallPending = false;
        applyUpdaterError(
          error instanceof Error ? error : new Error(String(error))
        );
        throw error;
      }
    },
    isQuitAndInstallPending() {
      return quitAndInstallPending;
    },
    onStateChanged(listener) {
      stateChangedListeners.add(listener);
      return () => {
        stateChangedListeners.delete(listener);
      };
    }
  };

  const runBackgroundCheck = (reason: string): void => {
    void service.checkForUpdates().catch((error) => {
      getDesktopLogger().warn("background application update check failed", {
        error: formatErrorDetail(error),
        reason
      });
    });
  };

  const applyPrefixedReleaseFallback = async (
    error: unknown
  ): Promise<AppUpdateState | null> => {
    if (!prefixedReleaseResolver || !isNoPublishedVersionsError(error)) {
      return null;
    }

    try {
      const release = await prefixedReleaseResolver({
        channel: state.channel,
        currentVersion
      });
      const checkedAt = new Date().toISOString();
      if (!release) {
        return applyState({
          ...buildBaseState(
            currentVersion,
            state.policy,
            state.channel,
            "up_to_date"
          ),
          checkedAt
        });
      }

      const current = parseDesktopVersion(currentVersion);
      const latest = parseDesktopVersion(release.version);
      if (current && latest && compareDesktopVersions(latest, current) <= 0) {
        return applyState({
          ...buildBaseState(
            currentVersion,
            state.policy,
            state.channel,
            "up_to_date"
          ),
          checkedAt
        });
      }

      getDesktopLogger().info(
        "application update found from prefixed GitHub release tag",
        {
          channel: state.channel,
          tag_name: release.tagName,
          version: release.version
        }
      );
      return applyState({
        ...buildBaseState(
          currentVersion,
          state.policy,
          state.channel,
          "available"
        ),
        checkedAt,
        latestVersion: release.version,
        releaseDate: release.publishedAt,
        releaseName: release.name ?? release.tagName,
        releaseNotesUrl: release.htmlUrl
      });
    } catch (fallbackError) {
      getDesktopLogger().warn(
        "failed to resolve prefixed GitHub desktop release",
        {
          error: formatErrorDetail(fallbackError),
          original_error: formatErrorDetail(error)
        }
      );
      return null;
    }
  };

  return service;
}
