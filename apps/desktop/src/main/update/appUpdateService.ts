import electron from "electron";
import electronUpdater, {
  type AppUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo
} from "electron-updater";
import {
  createMandatoryUpdaterLeaseManager,
  type MandatoryDesktopUpdateSession,
  type MandatoryDesktopUpdateTarget
} from "@tutti-os/desktop-update-admission/mandatory-updater";
import {
  completeDevelopmentUpdateInstallation,
  createDevelopmentAppUpdateDriver,
  type DesktopUpdateDevelopmentScenario
} from "@tutti-os/desktop-update-admission/development";
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
  createDesktopReleaseFeedResolver,
  type DesktopReleaseFeed,
  type DesktopReleaseFeedResolver
} from "./desktopReleaseFeed.ts";

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
  setFeedUrl(url: string): void;
}

export interface AppUpdateService {
  checkForUpdates(reason?: string): Promise<AppUpdateState>;
  configure(input: ConfigureAppUpdatesInput): Promise<AppUpdateState>;
  dispose(): void;
  downloadUpdate(): Promise<AppUpdateState>;
  getState(): AppUpdateState;
  installUpdate(): Promise<void>;
  acquireMandatorySession(
    input: MandatoryDesktopUpdateTarget
  ): Promise<MandatoryAppUpdateSession>;
  isQuitAndInstallPending(): boolean;
  onStateChanged(
    listener: (state: AppUpdateState, previousState: AppUpdateState) => void
  ): () => void;
}

export type MandatoryAppUpdateSession = MandatoryDesktopUpdateSession;

interface AppUpdateServiceOptions {
  currentVersion?: string;
  developmentScenario?: DesktopUpdateDevelopmentScenario | null;
  releaseFeedResolver?: DesktopReleaseFeedResolver | null;
  supportsUpdates?: boolean;
  unsupportedMessage?: string;
}

export function createElectronAppUpdateDriver(
  updater: AppUpdater
): AppUpdateDriver {
  updater.logger = createElectronUpdaterLogger({
    logger: getDesktopLogger()
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
    },
    setFeedUrl(url) {
      updater.setFeedURL({ provider: "generic", url });
    }
  };
}

export function createElectronUpdaterLogger(options: {
  logger: Pick<DesktopLogger, "debug" | "error" | "info" | "warn">;
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
    return "Unable to read the application update feed.";
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

export function createAppUpdateService(
  driver?: AppUpdateDriver,
  options: AppUpdateServiceOptions = {}
): AppUpdateService {
  const isPackaged = Boolean(app?.isPackaged);
  const developmentScenario = options.developmentScenario ?? null;
  if (isPackaged && developmentScenario) {
    throw new Error(
      "packaged desktop cannot use a development update scenario"
    );
  }
  const currentVersion =
    options.currentVersion ?? app?.getVersion?.() ?? "0.0.0";
  if (
    developmentScenario &&
    currentVersion !== developmentScenario.currentVersion
  ) {
    throw new Error(
      "development updater currentVersion must match the admission scenario"
    );
  }
  const developmentMockDriver =
    !driver && developmentScenario
      ? createDevelopmentAppUpdateDriver(developmentScenario)
      : null;
  const releaseFeedResolver =
    options.releaseFeedResolver === undefined
      ? driver || developmentMockDriver
        ? null
        : createDesktopReleaseFeedResolver()
      : options.releaseFeedResolver;
  const resolvedDriver =
    driver ??
    developmentMockDriver ??
    createElectronAppUpdateDriver(electronUpdater.autoUpdater);
  let supportsUpdates =
    options.supportsUpdates ??
    ((process.env.NODE_ENV !== "test" && isPackaged) ||
      developmentScenario !== null);
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
  let activeReleaseFeed: DesktopReleaseFeed | null = null;
  const stateChangedListeners = new Set<
    (state: AppUpdateState, previousState: AppUpdateState) => void
  >();
  let normalConfiguration: ConfigureAppUpdatesInput | null = null;

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

  let service: AppUpdateService;
  const mandatoryUpdater =
    createMandatoryUpdaterLeaseManager<ConfigureAppUpdatesInput>({
      captureNormalConfiguration: () =>
        normalConfiguration ? { ...normalConfiguration } : null,
      async suspendNormalUpdates() {
        clearSchedule();
        await activeCheckPromise?.catch(() => undefined);
        await activeDownloadPromise?.catch(() => undefined);
      },
      async prepareMandatoryUpdate(input) {
        await service.configure(input);
        return await service.checkForUpdates();
      },
      downloadUpdate: () => service.downloadUpdate(),
      installUpdate: () => service.installUpdate(),
      getState: () => service.getState(),
      restoreNormalConfiguration: (configuration) =>
        service.configure(configuration).then(() => undefined)
    });

  const assertUpdaterAccess = (): void => mandatoryUpdater.assertAccess();

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

  const applyUpdaterErrorIfNeeded = (error: Error): void => {
    const message = normalizeMessage(error);
    if (state.status === "error" && state.message === message) {
      return;
    }
    applyUpdaterError(error);
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
        releaseName: info.releaseName ?? null,
        releaseNotesUrl:
          activeReleaseFeed?.version === info.version
            ? activeReleaseFeed.releaseNotesUrl
            : null
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
      applyUpdaterErrorIfNeeded(error);
      quitAndInstallPending = false;
    })
  ];

  service = {
    async checkForUpdates(reason = "manual") {
      assertUpdaterAccess();
      if (
        !supportsUpdates ||
        state.policy === "off" ||
        state.status === "downloaded"
      ) {
        getDesktopLogger().debug?.("application update check skipped", {
          reason,
          status: state.status,
          supports_updates: supportsUpdates,
          policy: state.policy
        });
        return state;
      }

      if (activeCheckPromise) {
        getDesktopLogger().debug?.("application update check joined", {
          reason
        });
        await activeCheckPromise;
        return state;
      }

      activeCheckPromise = runStaticFeedUpdateCheck(reason).finally(() => {
        activeCheckPromise = null;
      });
      await activeCheckPromise;
      return state;
    },
    configure(input) {
      assertUpdaterAccess();
      if (!mandatoryUpdater.isMandatoryAccess()) {
        normalConfiguration = { ...input };
      }
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
        channel: updaterChannel
      });
      resetConfiguredState("idle");
      if (!mandatoryUpdater.isMandatoryAccess()) {
        scheduleChecks();
        runBackgroundCheck("configure");
      }
      return Promise.resolve(state);
    },
    dispose() {
      clearSchedule();
      for (const dispose of driverDisposers) {
        dispose();
      }
    },
    async downloadUpdate() {
      assertUpdaterAccess();
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
        await service.checkForUpdates("download");
      } finally {
        preserveAvailableStateDuringCheck = false;
      }
      if (state.status !== "available") {
        return state;
      }

      getDesktopLogger().info("application update download started", {
        channel: state.channel,
        latest_version: state.latestVersion,
        policy: state.policy
      });
      activeDownloadPromise = resolvedDriver
        .downloadUpdate()
        .catch((error) => {
          const updateError =
            error instanceof Error
              ? error
              : new Error(formatErrorDetail(error));
          applyUpdaterErrorIfNeeded(updateError);
          throw updateError;
        })
        .finally(() => {
          getDesktopLogger().info("application update download finished", {
            channel: state.channel,
            latest_version: state.latestVersion,
            status: state.status
          });
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
      assertUpdaterAccess();
      if (state.status !== "downloaded" || quitAndInstallPending) {
        return;
      }
      if (developmentScenario) {
        completeDevelopmentUpdateInstallation(developmentScenario);
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
    async acquireMandatorySession(input) {
      return await mandatoryUpdater.acquire(input);
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
    void service.checkForUpdates(reason).catch((error) => {
      getDesktopLogger().warn("background application update check failed", {
        error: formatErrorDetail(error),
        reason
      });
    });
  };

  const runStaticFeedUpdateCheck = async (reason: string): Promise<void> => {
    getDesktopLogger().info("application update check started", {
      channel: state.channel,
      policy: state.policy,
      reason
    });
    try {
      if (releaseFeedResolver) {
        const feed = await releaseFeedResolver({ channel: state.channel });
        activeReleaseFeed = feed;
        resolvedDriver.setFeedUrl(feed.feedUrl);
        getDesktopLogger().info("application updater static feed configured", {
          channel: state.channel,
          feed_url: feed.feedUrl,
          tag_name: feed.tag,
          version: feed.version
        });
      }

      await resolvedDriver.checkForUpdates();
      getDesktopLogger().info("application update check finished", {
        channel: state.channel,
        latest_version: state.latestVersion,
        reason,
        status: state.status
      });
    } catch (error) {
      const updateError =
        error instanceof Error ? error : new Error(formatErrorDetail(error));
      applyUpdaterErrorIfNeeded(updateError);
      throw updateError;
    }
  };

  return service;
}
