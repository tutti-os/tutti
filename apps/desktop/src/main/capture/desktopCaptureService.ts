import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import {
  BrowserWindow,
  app,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
  type Display,
  type NativeImage
} from "electron";
import type {
  TuttiExternalAtQueryResult,
  TuttiExternalAtResolveResult,
  TuttiExternalAgentActivityActivateSessionResult,
  TuttiExternalAgentActivityComposerOptions,
  TuttiExternalAgentTargetCatalog,
  TuttiExternalUserProjectPathInput
} from "@tutti-os/workspace-external-core/contracts";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import {
  normalizeTuttiExternalAgentActivityActivateSessionInput,
  normalizeTuttiExternalAgentActivityComposerOptionsInput,
  normalizeTuttiExternalAgentActivityRememberComposerDefaultsInput,
  normalizeTuttiExternalAtQueryDirectoryInput,
  normalizeTuttiExternalAtQueryInput,
  normalizeTuttiExternalAtResolveInput,
  normalizeTuttiExternalUserProjectPathInput,
  normalizeTuttiExternalUserProjectSelectionPreparationInput
} from "@tutti-os/workspace-external-core/core";
import type {
  WorkspaceUserProject,
  WorkspaceUserProjectSelectionPreparation
} from "@tutti-os/workspace-user-project/contracts";
import type { DesktopHostPreferencesState } from "../desktopHostPreferences.ts";
import type { DesktopLogger } from "../logging.ts";
import { getDesktopThemeState } from "../desktopTheme.ts";
import {
  findWorkspaceWindow,
  getWorkspaceWindowWorkspaceID
} from "../windows/workspaceWindow.ts";
import {
  desktopIpcChannels,
  type DesktopWorkspaceAppExternalRendererRequest,
  type DesktopWorkspaceAppExternalRendererResult
} from "../../shared/contracts/ipc.ts";
import type {
  DesktopCaptureAgentOption,
  DesktopCaptureAttachment,
  DesktopCaptureComposerOptions,
  DesktopCaptureComposerOptionsInput,
  DesktopCaptureSelectionInput,
  DesktopCaptureSelectionResult,
  DesktopCaptureState,
  DesktopCaptureSubmitInput,
  DesktopCaptureSubmitResult
} from "../../shared/contracts/capture.ts";
import { registerDesktopIpcHandler } from "../ipc/handle.ts";
import { requestWorkspaceOwnerRenderer } from "../ipc/workspaceAppRendererBridge.ts";
import {
  createWorkspaceAppRendererReadiness,
  type WorkspaceAppRendererReadiness
} from "../ipc/workspaceAppRendererReadiness.ts";
import {
  normalizeCaptureSelection,
  resolveCaptureComposerBounds,
  resolveCaptureTitle,
  type CaptureBounds
} from "./captureGeometry.ts";
import { normalizeCapturePromptContent } from "./captureAgentPrompt.ts";
import { resolveCaptureAgentCapabilities } from "../../shared/capture/captureAgentCapabilities.ts";
import {
  createCaptureComposerPlacementStore,
  type CaptureComposerPosition
} from "./captureComposerPlacement.ts";
import {
  enterCaptureSelectionFullscreen,
  leaveCaptureSelectionFullscreen,
  resolveCaptureSelectionFullscreenOptions,
  type CaptureSelectionFullscreenExit
} from "./captureSelectionFullscreen.ts";
import {
  desktopCaptureAccelerator,
  resolveCaptureAccelerator
} from "./captureShortcut.ts";
import type { DesktopFileDialogAccess } from "../host/desktopFileDialogAccess.ts";
import { activateDesktopWindow } from "../host/desktopWindowActivation.ts";
import {
  CaptureSelectionSupersededError,
  runCaptureSelectionTransition
} from "./captureSelectionTransition.ts";

const captureComposerWidth = 760;
const captureComposerHeight = 520;
const captureRendererAppId = "desktop-capture";

type DesktopCaptureComposerOptionsLoad =
  | { error: null; options: DesktopCaptureComposerOptions }
  | { error: Error; options: null };

interface ActiveCapture {
  captureId: string;
  closing: boolean;
  composerBounds: CaptureBounds | null;
  composerMovementTrackingEnabled: boolean;
  composerOptions: Promise<DesktopCaptureComposerOptionsLoad>;
  display: Display;
  image: NativeImage;
  returnFocusToExternalApplication: boolean;
  selected: DesktopCaptureAttachment | null;
  selection: Promise<DesktopCaptureSelectionResult> | null;
  state: DesktopCaptureState;
  submission: Promise<DesktopCaptureSubmitResult> | null;
  window: BrowserWindow;
  workspaceRendererReadiness: WorkspaceAppRendererReadiness;
}

export interface DesktopCaptureService {
  dispose(): void;
}

export function createDesktopCaptureService(input: {
  ensureWorkspaceOwner(workspaceId: string): Promise<void>;
  fileDialogs: Pick<
    DesktopFileDialogAccess,
    "selectDirectory" | "selectUploadFiles"
  >;
  logger: DesktopLogger;
  preferences: Pick<
    DesktopHostPreferencesState,
    "getLocale" | "getThemeSource" | "getWorkbenchShortcuts" | "subscribe"
  >;
  preloadPath: string;
  rendererFilePath: string;
  rendererUrl?: string;
  resolveStartupWorkspaceId(): Promise<string | null>;
}): DesktopCaptureService {
  const workspaceRendererReadiness = createWorkspaceAppRendererReadiness({
    ipc: ipcMain
  });
  const composerPlacementStore = createCaptureComposerPlacementStore(
    join(app.getPath("userData"), "capture-composer-placement.json")
  );
  let activeCapture: ActiveCapture | null = null;
  let composerPositionDirty = false;
  let openingCapture = false;
  let lastWorkspaceId = resolveFocusedWorkspaceId();
  let rememberedComposerPosition: CaptureComposerPosition | null = null;
  const composerPositionLoaded = composerPlacementStore
    .read()
    .then((position) => {
      if (!composerPositionDirty) {
        rememberedComposerPosition = position;
      }
    })
    .catch((error) => {
      input.logger.warn("failed to restore screenshot composer position", {
        error: error instanceof Error ? error.message : String(error)
      });
    });

  const isCurrentCapture = (capture: ActiveCapture): boolean =>
    activeCapture === capture &&
    !capture.closing &&
    !capture.window.isDestroyed();

  const rememberComposerPosition = (position: CaptureComposerPosition) => {
    rememberedComposerPosition = position;
    composerPositionDirty = true;
  };
  const persistComposerPosition = () => {
    const position = rememberedComposerPosition;
    if (!composerPositionDirty || !position) {
      return;
    }
    composerPositionDirty = false;
    void composerPlacementStore.write(position).catch((error) => {
      composerPositionDirty = true;
      input.logger.warn("failed to persist screenshot composer position", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  };

  const onBrowserWindowFocus = (
    _event: Electron.Event,
    window: BrowserWindow
  ) => {
    const workspaceId = getWorkspaceWindowWorkspaceID(window);
    if (workspaceId) {
      lastWorkspaceId = workspaceId;
    }
  };
  app.on("browser-window-focus", onBrowserWindowFocus);

  const trustedActiveCapture = (
    sender: Electron.WebContents
  ): ActiveCapture => {
    if (
      !activeCapture ||
      activeCapture.closing ||
      activeCapture.window.isDestroyed() ||
      activeCapture.window.webContents !== sender
    ) {
      throw new Error("Screenshot capture window is unavailable");
    }
    return activeCapture;
  };

  registerDesktopIpcHandler(
    desktopIpcChannels.capture.getState,
    (event) => trustedActiveCapture(event.sender).state
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.capture.getComposerOptions,
    async (event, payload) => {
      const capture = trustedActiveCapture(event.sender);
      const agentTargetId = payload.agentTargetId.trim();
      if (!agentTargetId) {
        throw new Error("Screenshot Agent target is required");
      }
      const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
      const agent = await loadCaptureAgentOptionForCapture(
        capture,
        agentTargetId,
        cwd,
        payload.settings ?? null
      );
      return { agents: [agent] };
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.capture.queryMentions,
    async (event, payload) => {
      const capture = trustedActiveCapture(event.sender);
      const query = normalizeTuttiExternalAtQueryInput(payload);
      return requestCaptureWorkspaceOwner<TuttiExternalAtQueryResult[]>(
        capture,
        {
          appId: captureRendererAppId,
          input: query,
          operation: "at.query",
          requestId: randomUUID(),
          workspaceId: capture.state.workspaceId
        }
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.capture.queryMentionDirectory,
    async (event, payload) => {
      const capture = trustedActiveCapture(event.sender);
      const query = normalizeTuttiExternalAtQueryDirectoryInput(payload);
      return requestCaptureWorkspaceOwner<TuttiExternalAtQueryResult[]>(
        capture,
        {
          appId: captureRendererAppId,
          input: query,
          operation: "at.queryDirectory",
          requestId: randomUUID(),
          workspaceId: capture.state.workspaceId
        }
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.capture.resolveMention,
    async (event, payload) => {
      const capture = trustedActiveCapture(event.sender);
      const mention = normalizeTuttiExternalAtResolveInput(payload);
      return requestCaptureWorkspaceOwner<TuttiExternalAtResolveResult | null>(
        capture,
        {
          appId: captureRendererAppId,
          input: mention,
          operation: "at.resolve",
          requestId: randomUUID(),
          workspaceId: capture.state.workspaceId
        }
      );
    }
  );
  registerDesktopIpcHandler(desktopIpcChannels.capture.cancel, (event) => {
    const capture = trustedActiveCapture(event.sender);
    if (!capture.submission) {
      input.logger.info("screenshot capture cancelled", {
        captureId: capture.captureId,
        workspaceId: capture.state.workspaceId
      });
      cancelCapture(capture);
    }
  });
  registerDesktopIpcHandler(
    desktopIpcChannels.capture.rememberComposerDefaults,
    async (event, payload) => {
      const capture = trustedActiveCapture(event.sender);
      const defaultsInput =
        normalizeTuttiExternalAgentActivityRememberComposerDefaultsInput(
          payload
        );
      await requestCaptureWorkspaceOwner<void>(capture, {
        appId: captureRendererAppId,
        input: defaultsInput,
        operation: "agentActivity.rememberComposerDefaults",
        requestId: randomUUID(),
        workspaceId: capture.state.workspaceId
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.capture.select,
    async (event, selection) => {
      const capture = trustedActiveCapture(event.sender);
      const joined = capture.selection !== null;
      input.logger.info("screenshot selection requested", {
        captureId: capture.captureId,
        joined,
        workspaceId: capture.state.workspaceId
      });
      capture.selection ??= (async () => {
        const normalized = normalizeCaptureSelection(selection, {
          height: capture.state.displayHeight,
          width: capture.state.displayWidth
        });
        const selected = cropSelection(capture, normalized);
        capture.selected = selected;
        let loaded: DesktopCaptureComposerOptionsLoad;
        try {
          loaded = await runCaptureSelectionTransition({
            captureId: capture.captureId,
            isCurrent: () => isCurrentCapture(capture),
            metadata: capture.composerOptions,
            present: async (assertCurrent) => {
              await composerPositionLoaded;
              assertCurrent();
              const fullscreenExit = await presentComposer(
                capture,
                normalized,
                rememberedComposerPosition,
                assertCurrent
              );
              input.logger.info("screenshot composer presented", {
                captureId: capture.captureId,
                fullscreenExit,
                workspaceId: capture.state.workspaceId
              });
            }
          });
        } catch (error) {
          if (error instanceof CaptureSelectionSupersededError) {
            input.logger.info("screenshot selection superseded", {
              captureId: error.captureId,
              phase: error.phase,
              workspaceId: capture.state.workspaceId
            });
          }
          throw error;
        }
        if (loaded.error) {
          input.logger.warn("screenshot composer metadata unavailable", {
            captureId: capture.captureId,
            error: loaded.error.message,
            workspaceId: capture.state.workspaceId
          });
          throw loaded.error;
        }
        capture.state = {
          ...capture.state,
          ...loaded.options
        };
        input.logger.info("screenshot composer metadata ready", {
          captureId: capture.captureId,
          workspaceId: capture.state.workspaceId
        });
        return { attachment: selected, ...loaded.options };
      })();
      const selectionPromise = capture.selection;
      try {
        return await selectionPromise;
      } finally {
        if (capture.selection === selectionPromise) {
          capture.selection = null;
        }
      }
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.capture.selectFiles,
    async (event) => {
      const capture = trustedActiveCapture(event.sender);
      const paths = await input.fileDialogs.selectUploadFiles(capture.window, {
        allowDirectories: false
      });
      return paths.map(toHostFileReference);
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.capture.selectProjectDirectory,
    async (event) => {
      const capture = trustedActiveCapture(event.sender);
      const path = await input.fileDialogs.selectDirectory(capture.window);
      return path ? { path } : null;
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.capture.userProjectsList,
    async (event) => {
      const capture = trustedActiveCapture(event.sender);
      return requestCaptureWorkspaceOwner<{ projects: WorkspaceUserProject[] }>(
        capture,
        {
          appId: captureRendererAppId,
          operation: "userProjects.list",
          requestId: randomUUID(),
          workspaceId: capture.state.workspaceId
        }
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.capture.userProjectsPrepareSelection,
    async (event, payload) => {
      const capture = trustedActiveCapture(event.sender);
      const projectInput =
        normalizeTuttiExternalUserProjectSelectionPreparationInput(payload);
      return requestCaptureWorkspaceOwner<WorkspaceUserProjectSelectionPreparation>(
        capture,
        {
          appId: captureRendererAppId,
          input: projectInput,
          operation: "userProjects.prepareSelection",
          requestId: randomUUID(),
          workspaceId: capture.state.workspaceId
        }
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.capture.userProjectsUse,
    async (event, payload) => {
      const capture = trustedActiveCapture(event.sender);
      const projectInput: TuttiExternalUserProjectPathInput =
        normalizeTuttiExternalUserProjectPathInput(payload, "use");
      return requestCaptureWorkspaceOwner<WorkspaceUserProject>(capture, {
        appId: captureRendererAppId,
        input: projectInput,
        operation: "userProjects.use",
        requestId: randomUUID(),
        workspaceId: capture.state.workspaceId
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.capture.submit,
    async (event, submission) => {
      const capture = trustedActiveCapture(event.sender);
      capture.submission ??= submitCapture(capture, submission);
      // Panel interactions have no diagnostics channel, so the resolved
      // settings are recorded here — the only durable record of what the
      // composer displayed at submit time.
      input.logger.info("screenshot capture submitted", {
        agentTargetId: submission.agentTargetId,
        captureId: capture.captureId,
        cwd: submission.cwd ?? null,
        settings: submission.settings ?? null,
        workspaceId: capture.state.workspaceId
      });
      try {
        const result = await capture.submission;
        const workspaceId = capture.state.workspaceId;
        closeSubmittedCapture(capture);
        focusWorkspace(workspaceId, input.logger);
        return result;
      } finally {
        capture.submission = null;
      }
    }
  );

  const openCapture = async (
    returnFocusToExternalApplication: boolean
  ): Promise<void> => {
    if (activeCapture) {
      const destroyed = activeCapture.window.isDestroyed();
      const shouldReplace =
        activeCapture.closing || destroyed || !activeCapture.window.isVisible();
      if (shouldReplace) {
        const replacedCapture = activeCapture;
        input.logger.info("screenshot capture replaced", {
          captureId: replacedCapture.captureId,
          closing: replacedCapture.closing,
          destroyed,
          visible: destroyed ? false : replacedCapture.window.isVisible(),
          workspaceId: replacedCapture.state.workspaceId
        });
        replacedCapture.closing = true;
        if (!destroyed) {
          replacedCapture.window.destroy();
        }
        if (activeCapture === replacedCapture) {
          activeCapture = null;
        }
      } else {
        app.show();
        activeCapture.window.show();
        activeCapture.window.focus();
        input.logger.info("screenshot capture reused", {
          captureId: activeCapture.captureId,
          selectionPending: activeCapture.selection !== null,
          selected: activeCapture.selected !== null,
          workspaceId: activeCapture.state.workspaceId
        });
        return;
      }
    }
    if (openingCapture) {
      return;
    }
    openingCapture = true;
    try {
      const workspaceId =
        resolveFocusedWorkspaceId() ??
        lastWorkspaceId ??
        (await input.resolveStartupWorkspaceId());
      if (!workspaceId) {
        input.logger.warn("screenshot capture skipped", {
          reason: "workspace_unavailable"
        });
        return;
      }
      lastWorkspaceId = workspaceId;
      activeCapture = await createCaptureWindow(
        input,
        workspaceId,
        returnFocusToExternalApplication,
        workspaceRendererReadiness,
        rememberComposerPosition,
        (capture) => {
          activeCapture = capture;
          capture.window.once("closed", () => {
            persistComposerPosition();
            input.logger.info("screenshot capture window closed", {
              captureId: capture.captureId,
              selected: capture.selected !== null,
              workspaceId: capture.state.workspaceId
            });
            if (activeCapture?.window === capture.window) {
              activeCapture = null;
            }
          });
        }
      );
    } catch (error) {
      if (activeCapture && !activeCapture.window.isDestroyed()) {
        activeCapture.closing = true;
        activeCapture.window.destroy();
      }
      activeCapture = null;
      input.logger.warn("screenshot capture failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      openingCapture = false;
    }
  };

  const captureShortcutCallback = () => {
    const returnFocusToExternalApplication =
      BrowserWindow.getFocusedWindow() === null;
    input.logger.info("screenshot shortcut activated", {
      activeCaptureId: activeCapture?.captureId ?? null,
      accelerator: registeredAccelerator
    });
    void openCapture(returnFocusToExternalApplication);
  };
  let registeredAccelerator: string | null = null;
  const tryRegisterCaptureShortcut = (accelerator: string): boolean => {
    try {
      return (
        globalShortcut.register(accelerator, captureShortcutCallback) &&
        globalShortcut.isRegistered(accelerator)
      );
    } catch {
      return false;
    }
  };
  const applyCaptureShortcut = () => {
    const accelerator = resolveCaptureAccelerator(
      input.preferences.getWorkbenchShortcuts().captureScreenshot
    );
    if (accelerator === registeredAccelerator) {
      return;
    }
    const previousAccelerator = registeredAccelerator;
    if (previousAccelerator) {
      globalShortcut.unregister(previousAccelerator);
      registeredAccelerator = null;
    }
    if (tryRegisterCaptureShortcut(accelerator)) {
      registeredAccelerator = accelerator;
      input.logger.info("screenshot shortcut registered", { accelerator });
      return;
    }
    input.logger.warn("screenshot shortcut registration failed", {
      accelerator
    });
    // Keep capture reachable: restore the last working accelerator, or the
    // built-in default when this was the initial registration.
    const fallback = previousAccelerator ?? desktopCaptureAccelerator;
    if (fallback !== accelerator && tryRegisterCaptureShortcut(fallback)) {
      registeredAccelerator = fallback;
      input.logger.info("screenshot shortcut registered", {
        accelerator: fallback
      });
    }
  };
  applyCaptureShortcut();
  const unsubscribePreferences =
    input.preferences.subscribe(applyCaptureShortcut);

  return {
    dispose() {
      persistComposerPosition();
      app.removeListener("browser-window-focus", onBrowserWindowFocus);
      unsubscribePreferences();
      if (registeredAccelerator) {
        globalShortcut.unregister(registeredAccelerator);
        registeredAccelerator = null;
      }
      workspaceRendererReadiness.dispose();
      for (const channel of Object.values(desktopIpcChannels.capture)) {
        ipcMain.removeHandler(channel);
      }
      if (activeCapture && !activeCapture.window.isDestroyed()) {
        activeCapture.closing = true;
        activeCapture.window.destroy();
      }
      activeCapture = null;
    }
  };
}

async function createCaptureWindow(
  input: Parameters<typeof createDesktopCaptureService>[0],
  workspaceId: string,
  returnFocusToExternalApplication: boolean,
  workspaceRendererReadiness: WorkspaceAppRendererReadiness,
  rememberComposerPosition: (position: CaptureComposerPosition) => void,
  activate: (capture: ActiveCapture) => void
): Promise<ActiveCapture> {
  const captureId = randomUUID();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const thumbnailSize = {
    width: Math.max(1, Math.round(display.size.width * display.scaleFactor)),
    height: Math.max(1, Math.round(display.size.height * display.scaleFactor))
  };
  const composerOptions = loadCaptureComposerOptionsWithOwner(
    input,
    workspaceId,
    workspaceRendererReadiness
  ).then<DesktopCaptureComposerOptionsLoad, DesktopCaptureComposerOptionsLoad>(
    (options) => ({ error: null, options }),
    (cause) => ({
      error: cause instanceof Error ? cause : new Error(String(cause)),
      options: null
    })
  );
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize
  });
  const source =
    sources.find((candidate) => candidate.display_id === String(display.id)) ??
    sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("Screen capture permission is unavailable");
  }
  const theme = getDesktopThemeState(input.preferences.getThemeSource());
  const captureWindow = new BrowserWindow({
    ...display.bounds,
    ...resolveCaptureSelectionFullscreenOptions(process.platform),
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: "#00000000",
    frame: false,
    fullscreenable: true,
    hasShadow: false,
    movable: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    transparent: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: input.preloadPath,
      sandbox: false
    }
  });
  captureWindow.setAlwaysOnTop(true, "screen-saver");
  if (process.platform === "darwin") {
    captureWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true
    });
  }
  const state: DesktopCaptureState = {
    agents: [],
    displayHeight: display.bounds.height,
    displayWidth: display.bounds.width,
    locale: input.preferences.getLocale(),
    screenshotDataUrl: source.thumbnail.toDataURL(),
    themeAppearance: theme.appearance,
    workspaceId
  };
  const capture: ActiveCapture = {
    captureId,
    closing: false,
    composerBounds: null,
    composerMovementTrackingEnabled: false,
    composerOptions,
    display,
    image: source.thumbnail,
    returnFocusToExternalApplication,
    selected: null,
    selection: null,
    state,
    submission: null,
    window: captureWindow,
    workspaceRendererReadiness
  };
  captureWindow.on("will-move", (_event, newBounds) => {
    if (capture.selected) {
      rememberComposerPosition({ x: newBounds.x, y: newBounds.y });
    }
  });
  if (process.platform === "linux") {
    captureWindow.on("move", () => {
      if (!capture.selected || !capture.composerMovementTrackingEnabled) {
        return;
      }
      const bounds = captureWindow.getBounds();
      if (
        capture.composerBounds?.x === bounds.x &&
        capture.composerBounds.y === bounds.y
      ) {
        return;
      }
      capture.composerBounds = bounds;
      rememberComposerPosition({ x: bounds.x, y: bounds.y });
    });
  }
  activate(capture);
  if (input.rendererUrl) {
    await captureWindow.loadURL(`${input.rendererUrl}/capture.html`);
  } else {
    await captureWindow.loadFile(input.rendererFilePath);
  }
  const fullscreenState = enterCaptureSelectionFullscreen(
    captureWindow,
    process.platform
  );
  if (process.platform === "darwin" && !fullscreenState.simpleFullScreen) {
    throw new Error("Screenshot selector failed to enter simple fullscreen");
  }
  captureWindow.show();
  captureWindow.focus();
  input.logger.info("screenshot selector presented", {
    captureId,
    displayBounds: display.bounds,
    displayWorkArea: display.workArea,
    fullScreen: fullscreenState.fullScreen,
    simpleFullScreen: fullscreenState.simpleFullScreen,
    windowBounds: captureWindow.getBounds()
  });
  return capture;
}

async function loadCaptureComposerOptionsWithOwner(
  input: Parameters<typeof createDesktopCaptureService>[0],
  workspaceId: string,
  workspaceRendererReadiness: WorkspaceAppRendererReadiness
): Promise<DesktopCaptureComposerOptions> {
  let workspaceWindow = resolveWorkspaceWindow(workspaceId);
  if (!workspaceWindow) {
    await input.ensureWorkspaceOwner(workspaceId);
    workspaceWindow = resolveWorkspaceWindow(workspaceId);
  }
  if (!workspaceWindow) {
    throw new Error("Workspace renderer is unavailable");
  }
  await workspaceRendererReadiness.waitFor(workspaceWindow);
  return loadCaptureAgentCatalog(workspaceWindow, workspaceId);
}

function cancelCapture(capture: ActiveCapture): void {
  if (capture.closing || capture.window.isDestroyed()) {
    return;
  }
  capture.closing = true;
  if (
    capture.returnFocusToExternalApplication &&
    process.platform === "darwin"
  ) {
    capture.window.once("closed", () => app.hide());
  }
  // Capture windows are ephemeral. Destroying is intentional here: a renderer
  // lifecycle handler must never keep a cancelled capture alive and block the
  // next global-shortcut invocation.
  capture.window.destroy();
}

function closeSubmittedCapture(capture: ActiveCapture): void {
  if (capture.closing || capture.window.isDestroyed()) {
    return;
  }
  capture.closing = true;
  // Same rationale as cancelCapture: `close()` can be held open by renderer
  // lifecycle handlers, leaving a submitted capture stranded on screen.
  capture.window.destroy();
}

function cropSelection(
  capture: ActiveCapture,
  raw: DesktopCaptureSelectionInput
): DesktopCaptureAttachment {
  const imageSize = capture.image.getSize();
  const scaleX = imageSize.width / capture.state.displayWidth;
  const scaleY = imageSize.height / capture.state.displayHeight;
  const cropped = capture.image.crop({
    x: Math.round(raw.x * scaleX),
    y: Math.round(raw.y * scaleY),
    width: Math.max(1, Math.round(raw.width * scaleX)),
    height: Math.max(1, Math.round(raw.height * scaleY))
  });
  const dataBase64 = cropped.toPNG().toString("base64");
  return {
    dataBase64,
    dataUrl: `data:image/png;base64,${dataBase64}`,
    displayName: `Screenshot-${new Date().toISOString().replaceAll(":", "-")}.png`,
    height: cropped.getSize().height,
    mimeType: "image/png",
    width: cropped.getSize().width
  };
}

async function loadCaptureAgentCatalog(
  workspaceWindow: BrowserWindow,
  workspaceId: string
): Promise<DesktopCaptureComposerOptions> {
  const catalog =
    await requestWorkspaceOwnerRenderer<TuttiExternalAgentTargetCatalog>(
      workspaceWindow,
      {
        appId: captureRendererAppId,
        operation: "agentActivity.listTargets",
        requestId: randomUUID(),
        workspaceId
      }
    );
  const agents = catalog.agents
    .filter((target) => target.availability.status === "ready")
    .map(
      (target): DesktopCaptureAgentOption => ({
        capabilities: { imageInput: false, workspaceReferences: true },
        composerOptions: null,
        ...(target.description ? { description: target.description } : {}),
        iconUrl: target.iconUrl,
        id: target.agentTargetId,
        name: target.name,
        provider: target.provider
      })
    );
  if (agents.length === 0) {
    throw new Error("Screenshot capture requires an available Agent");
  }
  return { agents };
}

async function loadCaptureAgentOptionForCapture(
  capture: ActiveCapture,
  agentTargetId: string,
  cwd: string,
  settings: DesktopCaptureComposerOptionsInput["settings"] = null
): Promise<DesktopCaptureAgentOption> {
  const workspaceWindow = resolveWorkspaceWindow(capture.state.workspaceId);
  if (!workspaceWindow) {
    throw new Error("Workspace renderer is unavailable");
  }
  await capture.workspaceRendererReadiness.waitFor(workspaceWindow);
  return loadCaptureAgentOption(
    workspaceWindow,
    capture.state.workspaceId,
    agentTargetId,
    cwd,
    settings
  );
}

async function loadCaptureAgentOption(
  workspaceWindow: BrowserWindow,
  workspaceId: string,
  agentTargetId: string,
  cwd: string,
  settings: DesktopCaptureComposerOptionsInput["settings"] = null
): Promise<DesktopCaptureAgentOption> {
  const catalog =
    await requestWorkspaceOwnerRenderer<TuttiExternalAgentTargetCatalog>(
      workspaceWindow,
      {
        appId: captureRendererAppId,
        operation: "agentActivity.listTargets",
        requestId: randomUUID(),
        workspaceId
      }
    );
  const target = catalog.agents.find(
    (candidate) =>
      candidate.agentTargetId === agentTargetId &&
      candidate.availability.status === "ready"
  );
  if (!target) {
    throw new Error("Screenshot Agent target is unavailable");
  }
  const options =
    await requestWorkspaceOwnerRenderer<TuttiExternalAgentActivityComposerOptions>(
      workspaceWindow,
      {
        appId: captureRendererAppId,
        input: normalizeTuttiExternalAgentActivityComposerOptionsInput({
          agentTargetId: target.agentTargetId,
          cwd: cwd || null,
          provider: target.provider,
          settings: settings ?? null
        }),
        operation: "agentActivity.getComposerOptions",
        requestId: randomUUID(),
        workspaceId
      }
    );
  return {
    capabilities: resolveCaptureAgentCapabilities(options),
    composerOptions: options,
    ...(target.description ? { description: target.description } : {}),
    iconUrl: target.iconUrl,
    id: target.agentTargetId,
    name: target.name,
    provider: target.provider
  };
}

async function presentComposer(
  capture: ActiveCapture,
  selection: DesktopCaptureSelectionInput,
  rememberedPosition: CaptureComposerPosition | null,
  assertCurrent: () => void
): Promise<CaptureSelectionFullscreenExit> {
  const bounds = resolveCaptureComposerBounds({
    composerHeight: Math.min(
      captureComposerHeight,
      capture.display.workArea.height
    ),
    composerWidth: Math.min(
      captureComposerWidth,
      capture.display.workArea.width
    ),
    displayBounds: capture.display.bounds,
    rememberedPosition,
    selection,
    workArea: capture.display.workArea
  });
  assertCurrent();
  capture.composerMovementTrackingEnabled = false;
  const fullscreenExit = await leaveCaptureSelectionFullscreen(
    capture.window,
    process.platform
  );
  assertCurrent();
  capture.window.setOpacity(0);
  capture.window.setFullScreenable(false);
  capture.window.setResizable(true);
  capture.window.setBounds(bounds);
  capture.composerBounds = bounds;
  capture.window.setResizable(false);
  capture.window.setBackgroundColor("#00000000");
  capture.window.setOpacity(1);
  capture.composerMovementTrackingEnabled = true;
  return fullscreenExit;
}

async function submitCapture(
  capture: ActiveCapture,
  input: DesktopCaptureSubmitInput
): Promise<DesktopCaptureSubmitResult> {
  const attachment = capture.selected;
  if (!attachment) {
    throw new Error("Screenshot selection is unavailable");
  }
  const agentTargetId = input.agentTargetId.trim();
  if (!agentTargetId) {
    throw new Error("Screenshot Agent target is required");
  }
  const content = normalizeCapturePromptContent(input.content);
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  const displayPrompt = input.displayPrompt?.trim() ?? "";
  const agent = await loadCaptureAgentOptionForCapture(
    capture,
    agentTargetId,
    cwd,
    input.settings ?? null
  );
  if (!agent.capabilities.imageInput) {
    throw new Error("Screenshot Agent target does not support image input");
  }
  const agentSessionId = randomUUID();
  await requestCaptureWorkspaceOwner<TuttiExternalAgentActivityActivateSessionResult>(
    capture,
    {
      appId: captureRendererAppId,
      input: normalizeTuttiExternalAgentActivityActivateSessionInput({
        agentSessionId,
        agentTargetId,
        clientSubmitId: randomUUID(),
        ...(cwd ? { cwd } : {}),
        initialContent: content,
        ...(displayPrompt ? { initialDisplayPrompt: displayPrompt } : {}),
        reveal: true,
        ...(input.settings ? { settings: input.settings } : {}),
        title: resolveCaptureTitle(displayPrompt, attachment.displayName),
        visible: true
      }),
      operation: "agentActivity.activateSession",
      requestId: randomUUID(),
      workspaceId: capture.state.workspaceId
    }
  );
  return { agentSessionId };
}

function resolveFocusedWorkspaceId(): string | null {
  const focused = BrowserWindow.getFocusedWindow();
  const focusedWorkspace = focused
    ? getWorkspaceWindowWorkspaceID(focused)
    : null;
  if (focusedWorkspace) {
    return focusedWorkspace;
  }
  for (const window of BrowserWindow.getAllWindows()) {
    const workspaceId = getWorkspaceWindowWorkspaceID(window);
    if (workspaceId) {
      return workspaceId;
    }
  }
  return null;
}

function resolveWorkspaceWindow(workspaceId: string): BrowserWindow | null {
  return (
    findWorkspaceWindow(workspaceId, "workspace") ??
    findWorkspaceWindow(workspaceId, "agent")
  );
}

function focusWorkspace(workspaceId: string, logger: DesktopLogger): void {
  const window = resolveWorkspaceWindow(workspaceId);
  if (!window) {
    logger.warn("screenshot workspace activation skipped", {
      reason: "workspace_window_unavailable",
      workspaceId
    });
    return;
  }
  const activated = activateDesktopWindow(app, window);
  setTimeout(() => {
    logger.info("screenshot workspace activation completed", {
      activated,
      appActive: process.platform === "darwin" ? app.isActive() : null,
      appHidden: process.platform === "darwin" ? app.isHidden() : null,
      dockVisible:
        process.platform === "darwin" ? (app.dock?.isVisible() ?? null) : null,
      windowDestroyed: window.isDestroyed(),
      windowFocused: window.isDestroyed() ? false : window.isFocused(),
      windowVisible: window.isDestroyed() ? false : window.isVisible(),
      workspaceId
    });
  }, 0);
}

function requestCaptureWorkspaceOwner<
  Result extends DesktopWorkspaceAppExternalRendererResult
>(
  capture: ActiveCapture,
  request: DesktopWorkspaceAppExternalRendererRequest
): Promise<Result> {
  const workspaceWindow = resolveWorkspaceWindow(capture.state.workspaceId);
  if (!workspaceWindow) {
    throw new Error("Workspace renderer is unavailable");
  }
  return capture.workspaceRendererReadiness
    .waitFor(workspaceWindow)
    .then(() =>
      requestWorkspaceOwnerRenderer<Result>(workspaceWindow, request)
    );
}

function toHostFileReference(path: string): WorkspaceFileReference {
  return {
    displayName: basename(path),
    hostPath: path,
    kind: "file",
    path,
    sourceId: "host-local-file"
  };
}
