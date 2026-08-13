import type {
  BrowserWindow as ElectronBrowserWindow,
  BrowserWindowConstructorOptions
} from "electron";
import {
  desktopUpdateAdmissionIpcChannels,
  type DesktopUpdateAdmissionBackend,
  type DesktopUpdateAdmissionRuntime,
  type DesktopUpdateAdmissionSnapshot,
  type DesktopProduct,
  type MinimumVersionAppUpdateService,
  type MinimumVersionCheckRequest,
  type MinimumVersionCheckResult,
  type MinimumVersionUpgradeError,
  type MinimumVersionUpgradeState,
  type UpgradeRequiredMinimumVersionCheckResult,
  type MandatoryDesktopUpdateSession,
  type MandatoryDesktopUpdateTarget
} from "../contracts/index.ts";
import {
  resolveMinimumVersionRuntimeTarget,
  validateMinimumVersionResponse
} from "../core/index.ts";
import { DevelopmentInstallSuppressedError } from "../development/updaterDriver.ts";
import { MandatoryUpdateTargetError } from "../mandatory-updater/index.ts";

export interface DesktopUpdateAdmissionElectronRuntime {
  app: typeof import("electron").app;
  BrowserWindow: typeof import("electron").BrowserWindow;
  ipcMain: typeof import("electron").ipcMain;
  shell: typeof import("electron").shell;
}

export interface DesktopUpdateAdmissionLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface DesktopUpdateAdmissionController {
  runStartupCheck(): Promise<boolean>;
  checkAfterForegroundRestore(): Promise<void>;
  dispose(): void;
}

export interface DesktopUpdateAdmissionControllerOptions<
  TProduct extends DesktopProduct
> {
  product: TProduct;
  runtime: DesktopUpdateAdmissionRuntime;
  electron: DesktopUpdateAdmissionElectronRuntime;
  backend: DesktopUpdateAdmissionBackend<TProduct>;
  featureAvailability?: {
    acceptDaemonSnapshot(
      snapshot: DesktopUpdateAdmissionSnapshot<TProduct>
    ): void;
  };
  updateService: MinimumVersionAppUpdateService;
  logger: DesktopUpdateAdmissionLogger;
  onPolicyReleased(): void | Promise<void>;
  preloadPath: string;
  rendererFilePath: string;
  rendererUrl?: string;
  manualDownloadUrl(
    response: UpgradeRequiredMinimumVersionCheckResult<TProduct>
  ): string;
  listBusinessWindows(): ElectronBrowserWindow[];
  icon?: BrowserWindowConstructorOptions["icon"];
  foregroundFailureRetryDelayMs?: number;
}

interface PolicyCheckOutcome<TProduct extends DesktopProduct> {
  response: MinimumVersionCheckResult<TProduct> | null;
  retryable: boolean;
}

function logMinimumVersionCheck(
  logger: DesktopUpdateAdmissionLogger,
  level: "info" | "error",
  details: Record<string, unknown>
): void {
  logger[level](`[minimum-version-check] ${JSON.stringify(details)}`);
}

export function createDesktopUpdateAdmissionController<
  TProduct extends DesktopProduct
>(
  options: DesktopUpdateAdmissionControllerOptions<TProduct>
): DesktopUpdateAdmissionController {
  const { app, BrowserWindow, ipcMain, shell } = options.electron;
  let foregroundPrompted = false;
  let state: MinimumVersionUpgradeState<TProduct> | null = null;
  let upgradeWindow: ElectronBrowserWindow | null = null;
  let mode: "startup" | "foreground" = "startup";
  let forcedFlowStarted = false;
  let installRequested = false;
  let disposed = false;
  let activeCheck: Promise<PolicyCheckOutcome<TProduct>> | null = null;
  let activeForcedFlow: Promise<void> | null = null;
  let foregroundRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let appQuitStarted = false;
  let mandatoryUpdateSession: MandatoryDesktopUpdateSession | null = null;
  const lifecycleAbort = new AbortController();
  const foregroundFailureRetryDelayMs =
    options.foregroundFailureRetryDelayMs ?? 5_000;

  const handleBeforeQuit = (): void => {
    appQuitStarted = true;
  };
  app.on("before-quit", handleBeforeQuit);

  const emitState = (): void => {
    if (state && upgradeWindow && !upgradeWindow.isDestroyed()) {
      upgradeWindow.webContents.send(
        desktopUpdateAdmissionIpcChannels.state,
        state
      );
    }
  };

  const applyState = (
    phase: MinimumVersionUpgradeState["phase"],
    update = options.updateService.getState(),
    message: MinimumVersionUpgradeError | null = null
  ): void => {
    if (!state) {
      return;
    }
    state = { ...state, message, phase, update };
    emitState();
  };

  const closeUpgradeWindow = (): void => {
    const currentWindow = upgradeWindow;
    upgradeWindow = null;
    if (currentWindow && !currentWindow.isDestroyed()) {
      currentWindow.destroy();
    }
  };

  const openUpgradeWindow = (nextMode: "startup" | "foreground"): void => {
    if (upgradeWindow && !upgradeWindow.isDestroyed()) {
      upgradeWindow.show();
      upgradeWindow.focus();
      return;
    }
    mode = nextMode;
    const businessWindows = options
      .listBusinessWindows()
      .filter(
        (candidate) => candidate !== upgradeWindow && !candidate.isDestroyed()
      );
    const parent =
      businessWindows.find((candidate) => candidate.isFocused()) ??
      businessWindows.find((candidate) => candidate.isVisible()) ??
      businessWindows[0];
    const window = new BrowserWindow({
      autoHideMenuBar: true,
      fullscreenable: false,
      height: 420,
      icon: options.icon,
      maximizable: false,
      minHeight: 380,
      minWidth: 480,
      modal: parent !== undefined,
      parent,
      resizable: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: options.preloadPath,
        sandbox: true
      },
      width: 520
    });
    upgradeWindow = window;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("close", (event) => {
      if (!appQuitStarted && (mode === "startup" || forcedFlowStarted)) {
        event.preventDefault();
        app.quit();
      }
    });
    window.on("closed", () => {
      if (upgradeWindow === window) {
        upgradeWindow = null;
      }
    });
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) {
        window.show();
      }
    });
    const search = `mode=${nextMode}`;
    if (options.rendererUrl) {
      void window.loadURL(`${options.rendererUrl}?${search}`);
    } else {
      void window.loadFile(options.rendererFilePath, { search });
    }
  };

  const requestPayload = (): MinimumVersionCheckRequest<TProduct> | null => {
    const target = resolveMinimumVersionRuntimeTarget(
      process.platform,
      process.arch
    );
    if (!target) {
      return null;
    }
    return {
      ...target,
      currentVersion: options.runtime.currentVersion,
      product: options.product
    };
  };

  const runPolicyCheck = async (
    stage: "startup" | "foreground" | "retry"
  ): Promise<PolicyCheckOutcome<TProduct>> => {
    const request = requestPayload();
    if (!request) {
      logMinimumVersionCheck(options.logger, "info", {
        architecture: process.arch,
        decision: "notApplicable",
        platform: process.platform,
        reason: "unsupportedRuntime",
        result: "success",
        stage
      });
      return { response: null, retryable: false };
    }
    const controller = new AbortController();
    const abortForLifecycle = (): void => controller.abort();
    lifecycleAbort.signal.addEventListener("abort", abortForLifecycle, {
      once: true
    });
    try {
      const snapshot =
        stage === "startup"
          ? await options.backend.getStartupSnapshot(controller.signal)
          : (
              await options.backend.refresh(
                stage === "retry" ? "retry" : "foreground",
                controller.signal
              )
            ).snapshot;
      if (
        snapshot.identity.product !== request.product ||
        snapshot.identity.platform !== request.platform ||
        snapshot.identity.architecture !== request.architecture ||
        snapshot.identity.currentVersion !== request.currentVersion
      ) {
        throw new Error("desktop update admission daemon identity mismatch");
      }
      if (options.featureAvailability) {
        try {
          options.featureAvailability.acceptDaemonSnapshot(snapshot);
        } catch (error) {
          logMinimumVersionCheck(options.logger, "error", {
            error: error instanceof Error ? error.message : String(error),
            result: "failure",
            stage: "feature-availability"
          });
        }
      }
      if (snapshot.policy.status !== "resolved") {
        logMinimumVersionCheck(
          options.logger,
          snapshot.policy.status === "failedOpen" ? "error" : "info",
          {
            failure:
              snapshot.policy.status === "failedOpen"
                ? snapshot.policy.failure.kind
                : null,
            result:
              snapshot.policy.status === "failedOpen" ? "failure" : "skipped",
            stage,
            status: snapshot.policy.status
          }
        );
        return {
          response: null,
          retryable:
            snapshot.policy.status === "failedOpen" &&
            snapshot.policy.failure.kind !== "invalidResponse"
        };
      }
      const validated = validateMinimumVersionResponse(
        snapshot.policy.response,
        request
      );
      logMinimumVersionCheck(options.logger, "info", {
        currentVersion: validated.currentVersion,
        decision: validated.decision,
        minimumVersion: validated.minimumVersion,
        policyRevision: validated.policyRevision,
        reason: validated.reason,
        result: "success",
        stage
      });
      return { response: validated, retryable: false };
    } catch (error) {
      logMinimumVersionCheck(options.logger, "error", {
        error: error instanceof Error ? error.message : String(error),
        result: "failure",
        stage
      });
      return { response: null, retryable: true };
    } finally {
      lifecycleAbort.signal.removeEventListener("abort", abortForLifecycle);
    }
  };

  const checkPolicy = async (
    stage: "startup" | "foreground" | "retry"
  ): Promise<PolicyCheckOutcome<TProduct>> => {
    if (activeCheck) {
      return activeCheck;
    }
    const pendingCheck = runPolicyCheck(stage);
    activeCheck = pendingCheck;
    try {
      return await pendingCheck;
    } finally {
      if (activeCheck === pendingCheck) {
        activeCheck = null;
      }
    }
  };

  const releaseMandatoryUpdater = async (
    restoreNormal = true
  ): Promise<void> => {
    const session = mandatoryUpdateSession;
    mandatoryUpdateSession = null;
    try {
      await session?.release({ restoreNormal });
    } catch (error) {
      logMinimumVersionCheck(options.logger, "error", {
        error: error instanceof Error ? error.message : String(error),
        result: "failure",
        stage: "normal-update-restore"
      });
    }
  };

  const releasePolicyBlock = async (): Promise<void> => {
    applyState("released");
    forcedFlowStarted = false;
    installRequested = false;
    await releaseMandatoryUpdater();
    closeUpgradeWindow();
    await options.onPolicyReleased();
  };

  const installForcedUpdate = async (): Promise<void> => {
    if (installRequested) {
      return;
    }
    installRequested = true;
    try {
      if (!mandatoryUpdateSession) {
        throw new Error("mandatory update session is unavailable");
      }
      await mandatoryUpdateSession.installUpdate();
    } catch (error) {
      installRequested = false;
      if (error instanceof DevelopmentInstallSuppressedError) {
        logMinimumVersionCheck(options.logger, "info", {
          result: "simulated",
          stage: "install"
        });
        applyState("simulationComplete", options.updateService.getState());
        return;
      }
      logMinimumVersionCheck(options.logger, "error", {
        error: error instanceof Error ? error.message : String(error),
        result: "failure",
        stage: "install"
      });
      applyState("error", options.updateService.getState(), "installFailed");
    }
  };

  const prepareAndDownloadForcedUpdate = async (): Promise<void> => {
    if (!state) {
      return;
    }
    try {
      forcedFlowStarted = true;
      applyState("checking");
      const target: MandatoryDesktopUpdateTarget = {
        channel: state.check.channel === "rc" ? "rc" : "stable",
        minimumVersion: state.check.minimumVersion,
        policyRevision: state.check.policyRevision
      };
      if (mandatoryUpdateSession) {
        mandatoryUpdateSession.retarget(target);
      } else {
        const acquiredSession =
          await options.updateService.acquireMandatorySession(target);
        if (disposed) {
          await acquiredSession.release({ restoreNormal: false });
          return;
        }
        mandatoryUpdateSession = acquiredSession;
      }
      const prepared = await mandatoryUpdateSession.prepare();
      if (prepared.status === "downloaded") {
        applyState("downloaded", prepared);
        await installForcedUpdate();
        return;
      }
      if (prepared.status !== "available") {
        applyState("error", prepared, "updateUnavailable");
        return;
      }
      applyState("ready", prepared);
      const downloaded = await mandatoryUpdateSession.downloadUpdate();
      if (downloaded.status !== "downloaded") {
        applyState("error", downloaded, "updateFailed");
        return;
      }
      applyState("downloaded", downloaded);
      await installForcedUpdate();
    } catch (error) {
      logMinimumVersionCheck(options.logger, "error", {
        error: error instanceof Error ? error.message : String(error),
        result: "failure",
        stage: "forced-update"
      });
      applyState(
        "error",
        options.updateService.getState(),
        error instanceof MandatoryUpdateTargetError
          ? "releaseBelowMinimum"
          : "updateFailed"
      );
    }
  };

  const runForcedUpdateFlow = (): Promise<void> => {
    if (activeForcedFlow) {
      return activeForcedFlow;
    }
    const pending = prepareAndDownloadForcedUpdate();
    activeForcedFlow = pending;
    void pending.then(
      () => {
        if (activeForcedFlow === pending) {
          activeForcedFlow = null;
        }
      },
      () => {
        if (activeForcedFlow === pending) {
          activeForcedFlow = null;
        }
      }
    );
    return pending;
  };

  const unsubscribeUpdate = options.updateService.subscribe((update) => {
    if (!state || !forcedFlowStarted) {
      return;
    }
    if (update.status === "downloading") {
      applyState("downloading", update);
    } else if (update.status === "error") {
      installRequested = false;
      applyState("error", update, "updateFailed");
    }
  });

  const assertUpgradeWindowSender = (senderId: number): void => {
    if (
      !upgradeWindow ||
      upgradeWindow.isDestroyed() ||
      upgradeWindow.webContents.id !== senderId
    ) {
      throw new Error(
        "desktop update admission IPC is restricted to the upgrade window"
      );
    }
  };

  ipcMain.handle(desktopUpdateAdmissionIpcChannels.getState, (event) => {
    assertUpgradeWindowSender(event.sender.id);
    return state;
  });
  ipcMain.handle(desktopUpdateAdmissionIpcChannels.start, async (event) => {
    assertUpgradeWindowSender(event.sender.id);
    await runForcedUpdateFlow();
    return state;
  });
  ipcMain.handle(desktopUpdateAdmissionIpcChannels.retry, async (event) => {
    assertUpgradeWindowSender(event.sender.id);
    await activeForcedFlow;
    const { response } = await checkPolicy("retry");
    if (!response) {
      applyState(
        "error",
        options.updateService.getState(),
        "policyCheckFailed"
      );
    } else if (response.decision !== "upgradeRequired") {
      await releasePolicyBlock();
    } else if (state) {
      state = { ...state, check: response };
      await runForcedUpdateFlow();
    }
    return state;
  });
  ipcMain.handle(desktopUpdateAdmissionIpcChannels.later, (event) => {
    assertUpgradeWindowSender(event.sender.id);
    if (mode === "foreground" && !forcedFlowStarted) {
      closeUpgradeWindow();
    }
  });
  ipcMain.handle(
    desktopUpdateAdmissionIpcChannels.manualDownload,
    async (event) => {
      assertUpgradeWindowSender(event.sender.id);
      if (!state) {
        return;
      }
      await shell.openExternal(options.manualDownloadUrl(state.check));
    }
  );
  ipcMain.handle(desktopUpdateAdmissionIpcChannels.exit, (event) => {
    assertUpgradeWindowSender(event.sender.id);
    app.quit();
  });
  ipcMain.handle(desktopUpdateAdmissionIpcChannels.restart, (event) => {
    assertUpgradeWindowSender(event.sender.id);
    if (state?.phase !== "simulationComplete") {
      throw new Error(
        "desktop update admission restart requires a completed update"
      );
    }
    app.relaunch();
    app.quit();
  });

  const checkAfterForegroundRestore = async (
    stage: "foreground" | "retry"
  ): Promise<void> => {
    if (
      !options.runtime.checksEnabled ||
      disposed ||
      foregroundPrompted ||
      (mode === "startup" &&
        upgradeWindow !== null &&
        !upgradeWindow.isDestroyed())
    ) {
      return;
    }
    const outcome = await checkPolicy(stage);
    const response = outcome.response;
    if (outcome.retryable && !foregroundRetryTimer) {
      foregroundRetryTimer = setTimeout(() => {
        foregroundRetryTimer = null;
        if (
          disposed ||
          foregroundPrompted ||
          !options
            .listBusinessWindows()
            .some(
              (candidate) => !candidate.isDestroyed() && candidate.isFocused()
            )
        ) {
          return;
        }
        void checkAfterForegroundRestore("retry");
      }, foregroundFailureRetryDelayMs);
    }
    if (disposed || !response || response.decision !== "upgradeRequired") {
      return;
    }
    if (foregroundRetryTimer) {
      clearTimeout(foregroundRetryTimer);
      foregroundRetryTimer = null;
    }
    foregroundPrompted = true;
    state = {
      check: response,
      message: null,
      phase: "blocked",
      update: options.updateService.getState()
    };
    openUpgradeWindow("foreground");
  };

  return {
    async runStartupCheck() {
      if (!options.runtime.checksEnabled) {
        return false;
      }
      const { response } = await checkPolicy("startup");
      if (!response || response.decision !== "upgradeRequired") {
        return false;
      }
      state = {
        check: response,
        message: null,
        phase: "blocked",
        update: options.updateService.getState()
      };
      openUpgradeWindow("startup");
      return true;
    },
    async checkAfterForegroundRestore() {
      await checkAfterForegroundRestore("foreground");
    },
    dispose() {
      disposed = true;
      if (foregroundRetryTimer) {
        clearTimeout(foregroundRetryTimer);
        foregroundRetryTimer = null;
      }
      lifecycleAbort.abort();
      void releaseMandatoryUpdater(false);
      app.removeListener("before-quit", handleBeforeQuit);
      unsubscribeUpdate();
      closeUpgradeWindow();
      for (const channel of Object.values(desktopUpdateAdmissionIpcChannels)) {
        if (channel !== desktopUpdateAdmissionIpcChannels.state) {
          ipcMain.removeHandler(channel);
        }
      }
    }
  };
}
