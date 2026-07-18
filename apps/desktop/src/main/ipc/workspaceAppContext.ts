import {
  BrowserWindow,
  ipcMain,
  webContents,
  type IpcMainEvent,
  type WebContents
} from "electron";
import { createHmac, randomUUID } from "node:crypto";
import {
  desktopIpcChannels,
  type DesktopIpcResult,
  type DesktopWorkspaceAppExternalRendererEvent,
  type DesktopWorkspaceAppExternalRendererRequest,
  type DesktopWorkspaceAppExternalRendererResponse,
  type DesktopWorkspaceAppExternalRendererResult,
  type DesktopWorkspaceAppContext,
  type DesktopWorkspaceAppFileUploadCancelInput,
  type DesktopWorkspaceAppFileUploadCompleteInput,
  type DesktopWorkspaceAppFileUploadPrepareInput,
  type DesktopWorkspaceAppFileUploadPrepareResult,
  type DesktopWorkspaceAppOpenFileRequest
} from "../../shared/contracts/ipc";
import {
  normalizeTuttiExternalAtQueryInput,
  normalizeTuttiExternalAtResolveInput,
  normalizeTuttiExternalAtInvalidation,
  normalizeTuttiExternalFileOpenInput,
  normalizeTuttiExternalFileSelectInput,
  normalizeTuttiExternalFileUploadInput,
  normalizeTuttiExternalLogInput,
  normalizeTuttiExternalPdfPrintHtmlInput,
  normalizeTuttiExternalPermissionRequestInput,
  normalizeTuttiExternalReferenceOpenInput,
  normalizeTuttiExternalSettingsOpenInput,
  normalizeTuttiExternalUserProjectCreateInput,
  normalizeTuttiExternalUserProjectMoveInput,
  normalizeTuttiExternalUserProjectPathInput,
  normalizeTuttiExternalUserProjectRememberDefaultSelectionInput,
  normalizeTuttiExternalUserProjectSelectionPreparationInput,
  normalizeTuttiExternalWorkspaceOpenFeatureInput
} from "@tutti-os/workspace-external-core/core";
import type {
  TuttiExternalAtQueryResult,
  TuttiExternalAtResolveResult,
  TuttiExternalFileOpenInput,
  TuttiExternalFileSelectResult,
  TuttiExternalManagedAiModel,
  TuttiExternalManagedAiModelProviderId,
  TuttiExternalPdfMargin,
  TuttiExternalPdfPrintHtmlInput,
  TuttiExternalPdfPrintHtmlResult,
  TuttiExternalPermissionRequestInput,
  TuttiExternalPermissionRequestResult,
  TuttiExternalUploadedFile,
  TuttiExternalWorkspaceOpenRouteIntent
} from "@tutti-os/workspace-external-core/contracts";
import { isTuttiExternalManagedAiModelProviderId } from "@tutti-os/workspace-external-core/core";
import type { DesktopLocale } from "../../shared/i18n";
import type { DesktopHostPreferencesState } from "../desktopHostPreferences";
import type { DesktopLogger } from "../logging";
import {
  resolveDesktopDaemonBaseUrl,
  type DesktopDaemonEndpoint
} from "../transport/paths";
import { registerDesktopIpcHandler } from "./handle";
import {
  dispatchWorkspaceAppOpenUrl,
  installWorkspaceAppWindowOpenHandler
} from "./workspaceAppWindowOpen.ts";
import { reportWorkspaceAppUserActive } from "./workspaceAppActivityAnalytics.ts";
import {
  normalizeWorkspaceAppDiagnosticLogRecord,
  WorkspaceAppFrontendLogWriter,
  WorkspaceAppGuestLogRateLimiter
} from "./workspaceAppFrontendLogging.ts";
import { resolveWorkspaceAppOpenFilePayload } from "../host/workspaceAppFileOpen.ts";

const workspaceAppGuestWebContents = new Set<WebContents>();
const workspaceAppGuestContexts = new Map<number, WorkspaceAppGuestContext>();
const workspaceAppInitialLaunchIntents = new Map<
  string,
  TuttiExternalWorkspaceOpenRouteIntent
>();
let workspaceAppFrontendLogWriter: WorkspaceAppFrontendLogWriter | null = null;
let workspaceAppGuestLogRateLimiter: WorkspaceAppGuestLogRateLimiter | null =
  null;
type WorkspaceAppPrintLoadListener = (...args: unknown[]) => void;

interface WorkspaceAppGuestContext {
  appID: string;
  launchIntent?: TuttiExternalWorkspaceOpenRouteIntent;
  ownerWindow: BrowserWindow;
  workspaceID: string;
}

interface WorkspaceAppPrintWebContents {
  loadURL(url: string): Promise<void>;
  off(event: string, listener: WorkspaceAppPrintLoadListener): unknown;
  once(event: string, listener: WorkspaceAppPrintLoadListener): unknown;
}

export function registerWorkspaceAppGuestWebContents(
  ownerWindow: BrowserWindow,
  contents: WebContents,
  logger?: DesktopLogger,
  partition?: string | null
): void {
  workspaceAppGuestWebContents.add(contents);
  const context = readWorkspaceAppGuestContext(ownerWindow, partition);
  if (context) {
    workspaceAppGuestContexts.set(contents.id, context);
  } else {
    logger?.warn("workspace app guest context unavailable", {
      partition: partition ?? null,
      webContentsId: contents.id
    });
  }
  installWorkspaceAppWindowOpenHandler({ contents, logger, ownerWindow });
  contents.on("preload-error", (_event, preloadPath, error) => {
    logger?.warn("workspace app guest preload failed", {
      error: error.message,
      preloadPath,
      webContentsId: contents.id
    });
  });
  contents.once("destroyed", () => {
    workspaceAppGuestWebContents.delete(contents);
    workspaceAppGuestContexts.delete(contents.id);
    workspaceAppGuestLogRateLimiter?.forget(contents.id);
  });
}

export function registerWorkspaceAppContextIpc(
  endpoint: DesktopDaemonEndpoint,
  preferences: DesktopHostPreferencesState,
  options: {
    logger?: DesktopLogger;
    sessionID: string;
    stateRootDir: string;
  }
): void {
  const { logger, sessionID, stateRootDir } = options;
  workspaceAppGuestLogRateLimiter ??= new WorkspaceAppGuestLogRateLimiter();
  workspaceAppFrontendLogWriter ??= new WorkspaceAppFrontendLogWriter(
    stateRootDir,
    sessionID,
    workspaceAppGuestLogRateLimiter
  );
  registerDesktopIpcHandler(desktopIpcChannels.appContext.get, (event) =>
    createWorkspaceAppContext(
      endpoint,
      preferences.getLocale(),
      workspaceAppGuestContexts.get(event.sender.id)
    )
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.activityReportActive,
    async (event) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      try {
        await reportWorkspaceAppUserActive(endpoint, context);
      } catch (error: unknown) {
        logger?.warn("workspace app user active analytics failed", {
          appId: context.appID,
          error: error instanceof Error ? error.message : String(error),
          workspaceId: context.workspaceID
        });
      }
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.atQuery,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalAtQueryInput(payload);
      return requestWorkspaceAppExternalRenderer<TuttiExternalAtQueryResult[]>(
        context,
        {
          appId: context.appID,
          input,
          operation: "at.query",
          requestId: randomUUID(),
          workspaceId: context.workspaceID
        }
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.atResolve,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalAtResolveInput(payload);
      return requestWorkspaceAppExternalRenderer<TuttiExternalAtResolveResult | null>(
        context,
        {
          appId: context.appID,
          input,
          operation: "at.resolve",
          requestId: randomUUID(),
          workspaceId: context.workspaceID
        }
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.filesSelect,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalFileSelectInput(payload);
      return requestWorkspaceAppExternalRenderer<TuttiExternalFileSelectResult>(
        context,
        {
          appId: context.appID,
          input,
          operation: "files.select",
          requestId: randomUUID(),
          workspaceId: context.workspaceID
        }
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.filesOpen,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalFileOpenInput(payload);
      const request = toWorkspaceAppOpenFileRequest(input, payload);
      const resolved = await resolveWorkspaceAppOpenFilePayload({
        appId: context.appID,
        request,
        workspaceId: context.workspaceID
      });
      context.ownerWindow.webContents.send(
        desktopIpcChannels.appContext.openFileRequested,
        resolved
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.filesUploadPrepare,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeWorkspaceAppUploadPrepareInput(payload);
      const session = await requestWorkspaceAppUploadPrepare(
        endpoint,
        context,
        input
      );
      return createWorkspaceAppUploadContentPutRequest(
        endpoint,
        context,
        session.uploadId,
        session.expiresAt
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.filesUploadComplete,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeWorkspaceAppUploadCompleteInput(payload);
      return requestWorkspaceAppUploadComplete(
        endpoint,
        context,
        input.uploadId
      );
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.filesUploadCancel,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeWorkspaceAppUploadCancelInput(payload);
      await requestWorkspaceAppUploadCancel(endpoint, context, input.uploadId);
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.permissionsRequest,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalPermissionRequestInput(payload);
      return requestManagedAiModelPermission(endpoint, context, input);
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.pdfPrintHtml,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalPdfPrintHtmlInput(payload);
      return printWorkspaceAppHtmlToPdf(context, input);
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.settingsOpen,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalSettingsOpenInput(payload);
      return requestWorkspaceAppExternalRenderer<void>(context, {
        appId: context.appID,
        input,
        operation: "settings.open",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.referencesOpen,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalReferenceOpenInput(payload);
      return requestWorkspaceAppExternalRenderer<void>(context, {
        appId: context.appID,
        input,
        operation: "references.open",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsCheckPath,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalUserProjectPathInput(
        payload,
        "checkPath"
      );
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        input,
        operation: "userProjects.checkPath",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsCreate,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalUserProjectCreateInput(payload);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        input,
        operation: "userProjects.create",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsGetDefaultSelection,
    async (event) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        operation: "userProjects.getDefaultSelection",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsGetSnapshot,
    async (event) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        operation: "userProjects.getSnapshot",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsList,
    async (event) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        operation: "userProjects.list",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsMove,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalUserProjectMoveInput(payload);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        input,
        operation: "userProjects.move",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsPrepareSelection,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input =
        normalizeTuttiExternalUserProjectSelectionPreparationInput(payload);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        input,
        operation: "userProjects.prepareSelection",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsRefresh,
    async (event) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        operation: "userProjects.refresh",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsRememberDefaultSelection,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input =
        normalizeTuttiExternalUserProjectRememberDefaultSelectionInput(payload);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        input,
        operation: "userProjects.rememberDefaultSelection",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsSelectDirectory,
    async (event) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        operation: "userProjects.selectDirectory",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.userProjectsUse,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalUserProjectPathInput(payload, "use");
      return requestWorkspaceAppExternalRenderer(context, {
        appId: context.appID,
        input,
        operation: "userProjects.use",
        requestId: randomUUID(),
        workspaceId: context.workspaceID
      });
    }
  );
  ipcMain.on(
    desktopIpcChannels.appContext.diagnostic,
    (event, payload: unknown) => {
      const normalizedPayload = isWorkspaceAppDiagnosticPayload(payload)
        ? payload
        : null;
      writeWorkspaceAppDiagnosticLog(event.sender.id, normalizedPayload);
      const diagnosticEvent =
        typeof normalizedPayload?.event === "string"
          ? normalizedPayload.event
          : "";
      if (diagnosticEvent === "workspace-app-link-interception") {
        logger?.info("workspace app link interception diagnostic", {
          payload: normalizedPayload,
          webContentsId: event.sender.id
        });
        return;
      }
      if (diagnosticEvent.includes("failed")) {
        logger?.warn("workspace app context preload diagnostic", {
          payload: normalizedPayload
        });
      }
    }
  );
  ipcMain.on(
    desktopIpcChannels.appExternal.rendererEvent,
    (event, payload: unknown) => {
      const rendererEvent = isWorkspaceAppExternalRendererEvent(payload)
        ? payload
        : null;
      if (!rendererEvent) {
        return;
      }
      forwardWorkspaceAppExternalRendererEvent(event.sender, rendererEvent);
    }
  );
  ipcMain.on(
    desktopIpcChannels.appExternal.logsWrite,
    (event, payload: unknown) => {
      const context = workspaceAppGuestContexts.get(event.sender.id);
      if (
        !context ||
        !workspaceAppGuestWebContents.has(event.sender) ||
        event.sender.isDestroyed()
      ) {
        return;
      }

      try {
        const input = normalizeTuttiExternalLogInput(payload);
        workspaceAppFrontendLogWriter?.write(event.sender.id, context, input);
      } catch {
        // Fire-and-forget: invalid app payloads are silently ignored.
      }
    }
  );
  ipcMain.on(desktopIpcChannels.appContext.openUrl, (event, payload) => {
    const context = workspaceAppGuestContexts.get(event.sender.id);
    logger?.info("workspace app open-url IPC received", {
      hasContext: Boolean(context),
      payload: normalizeWorkspaceAppOpenUrlLogPayload(payload),
      webContentsId: event.sender.id
    });
    if (!context || !isWorkspaceAppOpenUrlPayload(payload)) {
      logger?.warn("workspace app open-url IPC ignored", {
        hasContext: Boolean(context),
        payload: normalizeWorkspaceAppOpenUrlLogPayload(payload),
        webContentsId: event.sender.id
      });
      return;
    }
    dispatchWorkspaceAppOpenUrl({
      contents: event.sender,
      logger,
      ownerWindow: context.ownerWindow,
      url: payload.url
    });
  });
  registerDesktopIpcHandler(
    desktopIpcChannels.appExternal.workspaceFeatureOpen,
    (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalWorkspaceOpenFeatureInput(payload);
      context.ownerWindow.webContents.send(
        desktopIpcChannels.appContext.openFeatureRequested,
        input
      );
    }
  );
  ipcMain.on(
    desktopIpcChannels.appContext.agentStatusBroadcast,
    (_event, payload: unknown) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as { agentBound?: unknown }).agentBound === "boolean"
      ) {
        broadcastWorkspaceAppContext({
          agentBound: (payload as { agentBound: boolean }).agentBound
        });
      }
    }
  );
  preferences.subscribe(() => {
    broadcastWorkspaceAppContext({
      locale: preferences.getLocale()
    });
  });
}

async function printWorkspaceAppHtmlToPdf(
  context: WorkspaceAppGuestContext,
  input: TuttiExternalPdfPrintHtmlInput
): Promise<TuttiExternalPdfPrintHtmlResult> {
  const printWindow = new BrowserWindow({
    height: 900,
    parent: context.ownerWindow,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: context.ownerWindow.webContents.session
    },
    width: 720
  });

  try {
    await loadPrintHtml(printWindow.webContents, input);
    const pdf = await printWindow.webContents.printToPDF({
      margins: printMargins(input.margin),
      pageSize: input.pageSize ?? "A4",
      preferCSSPageSize: input.preferCSSPageSize === true,
      printBackground: input.printBackground !== false
    });
    return { bytes: new Uint8Array(pdf) };
  } finally {
    if (!printWindow.isDestroyed()) {
      printWindow.destroy();
    }
  }
}

function loadPrintHtml(
  contents: WorkspaceAppPrintWebContents,
  input: TuttiExternalPdfPrintHtmlInput
): Promise<void> {
  const html = preparePrintHtml(input);
  const url = `data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("PDF print HTML load timed out."));
    }, 30_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      contents.off("did-finish-load", handleLoaded);
      contents.off("did-fail-load", handleFailed);
    };
    const handleLoaded = (): void => {
      cleanup();
      resolve();
    };
    const handleFailed: WorkspaceAppPrintLoadListener = (...args) => {
      const errorDescription =
        typeof args[2] === "string"
          ? args[2]
          : "PDF print HTML failed to load.";
      cleanup();
      reject(new Error(errorDescription));
    };
    contents.once("did-finish-load", handleLoaded);
    contents.once("did-fail-load", handleFailed);
    void contents.loadURL(url).catch((error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function preparePrintHtml(input: TuttiExternalPdfPrintHtmlInput): string {
  const base = input.baseUrl
    ? `<base href="${escapeHtml(input.baseUrl)}">`
    : "";
  const title = input.title ? `<title>${escapeHtml(input.title)}</title>` : "";
  const printHead = `${base}${title}`;
  if (!printHead) {
    return input.html;
  }
  if (/<head[^>]*>/iu.test(input.html)) {
    return input.html.replace(/<head([^>]*)>/iu, `<head$1>${printHead}`);
  }
  if (/<html[^>]*>/iu.test(input.html)) {
    return input.html.replace(
      /<html([^>]*)>/iu,
      `<html$1><head>${printHead}</head>`
    );
  }
  return `<!DOCTYPE html><html><head>${printHead}</head><body>${input.html}</body></html>`;
}

function printMargins(
  margin: TuttiExternalPdfMargin | undefined
): Electron.Margins | undefined {
  if (!margin) {
    return undefined;
  }
  return {
    marginType: "custom",
    bottom: marginToPixels(margin.bottom),
    left: marginToPixels(margin.left),
    right: marginToPixels(margin.right),
    top: marginToPixels(margin.top)
  };
}

function marginToPixels(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const match = value.match(/^(\d+(?:\.\d+)?)(px|in|cm|mm)$/u);
  if (!match) {
    return 0;
  }
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "px") {
    return amount;
  }
  if (unit === "in") {
    return amount * 96;
  }
  if (unit === "cm") {
    return (amount / 2.54) * 96;
  }
  return (amount / 25.4) * 96;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function writeWorkspaceAppDiagnosticLog(
  guestWebContentsId: number,
  payload: Record<string, unknown> | null
): void {
  if (!payload) {
    return;
  }

  const context = workspaceAppGuestContexts.get(guestWebContentsId);
  const record = normalizeWorkspaceAppDiagnosticLogRecord(payload);
  if (!context || !record) {
    return;
  }

  workspaceAppFrontendLogWriter?.write(guestWebContentsId, context, record);
}

function forwardWorkspaceAppExternalRendererEvent(
  ownerContents: WebContents,
  rendererEvent: DesktopWorkspaceAppExternalRendererEvent
): void {
  if (rendererEvent.type === "workspace.launchIntent") {
    persistWorkspaceAppInitialLaunchIntent(ownerContents.id, rendererEvent);
  }
  for (const [guestWebContentsId, context] of workspaceAppGuestContexts) {
    if (context.workspaceID !== rendererEvent.workspaceId) {
      continue;
    }
    if (
      rendererEvent.type === "workspace.launchIntent" &&
      context.appID !== rendererEvent.appId
    ) {
      continue;
    }
    if (context.ownerWindow.webContents.id !== ownerContents.id) {
      continue;
    }
    const guestContents = webContents.fromId(guestWebContentsId);
    if (
      !guestContents ||
      guestContents.isDestroyed() ||
      !workspaceAppGuestWebContents.has(guestContents)
    ) {
      continue;
    }
    guestContents.send(
      desktopIpcChannels.appExternal.guestEvent,
      rendererEvent
    );
  }
}

function persistWorkspaceAppInitialLaunchIntent(
  ownerWebContentsId: number,
  event: Extract<
    DesktopWorkspaceAppExternalRendererEvent,
    { type: "workspace.launchIntent" }
  >
): void {
  const key = workspaceAppInitialLaunchIntentKey({
    appID: event.appId,
    ownerWebContentsId,
    workspaceID: event.workspaceId
  });
  let matchedGuest = false;
  for (const context of workspaceAppGuestContexts.values()) {
    if (
      context.appID === event.appId &&
      context.workspaceID === event.workspaceId &&
      context.ownerWindow.webContents.id === ownerWebContentsId
    ) {
      matchedGuest = true;
    }
  }
  if (!matchedGuest) {
    workspaceAppInitialLaunchIntents.set(key, event.intent);
  }
}

function requireWorkspaceAppGuestContext(
  contents: WebContents
): WorkspaceAppGuestContext {
  const context = workspaceAppGuestContexts.get(contents.id);
  if (!workspaceAppGuestWebContents.has(contents) || !context) {
    throw new Error("Workspace app context is unavailable.");
  }
  if (contents.isDestroyed()) {
    throw new Error("Workspace app webContents is unavailable.");
  }
  if (context.ownerWindow.isDestroyed()) {
    throw new Error("Workspace owner window is unavailable.");
  }
  return context;
}

function requestWorkspaceAppExternalRenderer<
  TResult extends DesktopWorkspaceAppExternalRendererResult
>(
  context: WorkspaceAppGuestContext,
  request: DesktopWorkspaceAppExternalRendererRequest
): Promise<TResult> {
  const ownerWebContents = context.ownerWindow.webContents;
  if (ownerWebContents.isDestroyed()) {
    throw new Error("Workspace owner renderer is unavailable.");
  }

  return new Promise<TResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Workspace app external request timed out."));
    }, 30_000);

    const handleResponse = (event: IpcMainEvent, payload: unknown): void => {
      if (event.sender.id !== ownerWebContents.id) {
        return;
      }
      if (!isWorkspaceAppExternalRendererResponse(payload, request.requestId)) {
        return;
      }
      cleanup();
      if (payload.result.ok) {
        resolve(payload.result.data as TResult);
        return;
      }
      reject(new Error(payload.result.error.message));
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      ipcMain.off(
        desktopIpcChannels.appExternal.rendererResponse,
        handleResponse
      );
    };

    ipcMain.on(desktopIpcChannels.appExternal.rendererResponse, handleResponse);
    ownerWebContents.send(
      desktopIpcChannels.appExternal.rendererRequest,
      request
    );
  });
}

async function requestWorkspaceAppUploadPrepare(
  endpoint: DesktopDaemonEndpoint,
  context: WorkspaceAppGuestContext,
  input: DesktopWorkspaceAppFileUploadPrepareInput
): Promise<{ expiresAt: string; uploadId: string }> {
  const baseUrl = resolveDesktopDaemonBaseUrl(endpoint);
  // oxlint-disable-next-line no-restricted-globals -- talks to the local daemon, not outbound
  const response = await fetch(workspaceAppUploadSessionUrl(baseUrl, context), {
    body: JSON.stringify(input),
    headers: {
      Authorization: `Bearer ${endpoint.accessToken}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  });
  if (!response.ok) {
    const message = await readWorkspaceAppUploadError(
      response,
      "Prepare workspace app upload"
    );
    throw new Error(message);
  }
  return normalizeWorkspaceAppUploadPrepareResponse(await response.json());
}

function createWorkspaceAppUploadContentPutRequest(
  endpoint: DesktopDaemonEndpoint,
  context: WorkspaceAppGuestContext,
  uploadId: string,
  expiresAt: string
): DesktopWorkspaceAppFileUploadPrepareResult {
  const baseUrl = resolveDesktopDaemonBaseUrl(endpoint);
  return {
    expiresAt,
    headers: {
      Authorization: `Bearer ${createAppServerToken(
        endpoint.accessToken,
        context.workspaceID,
        context.appID
      )}`,
      "Content-Type": "application/octet-stream"
    },
    method: "PUT",
    uploadId,
    url: new URL(
      `${workspaceAppUploadSessionPath(context)}/${encodeURIComponent(uploadId)}/content`,
      baseUrl
    ).toString()
  };
}

async function requestWorkspaceAppUploadComplete(
  endpoint: DesktopDaemonEndpoint,
  context: WorkspaceAppGuestContext,
  uploadId: string
): Promise<TuttiExternalUploadedFile> {
  const baseUrl = resolveDesktopDaemonBaseUrl(endpoint);
  // oxlint-disable-next-line no-restricted-globals -- talks to the local daemon, not outbound
  const response = await fetch(
    new URL(
      `${workspaceAppUploadSessionPath(context)}/${encodeURIComponent(uploadId)}/complete`,
      baseUrl
    ),
    {
      headers: {
        Authorization: `Bearer ${endpoint.accessToken}`
      },
      method: "POST"
    }
  );
  if (!response.ok) {
    const message = await readWorkspaceAppUploadError(
      response,
      "Complete workspace app upload"
    );
    throw new Error(message);
  }
  return normalizeWorkspaceAppUploadCompleteResponse(await response.json());
}

async function requestWorkspaceAppUploadCancel(
  endpoint: DesktopDaemonEndpoint,
  context: WorkspaceAppGuestContext,
  uploadId: string
): Promise<void> {
  const baseUrl = resolveDesktopDaemonBaseUrl(endpoint);
  // oxlint-disable-next-line no-restricted-globals -- talks to the local daemon, not outbound
  const response = await fetch(
    new URL(
      `${workspaceAppUploadSessionPath(context)}/${encodeURIComponent(uploadId)}`,
      baseUrl
    ),
    {
      headers: {
        Authorization: `Bearer ${endpoint.accessToken}`
      },
      method: "DELETE"
    }
  );
  if (!response.ok) {
    const message = await readWorkspaceAppUploadError(
      response,
      "Cancel workspace app upload"
    );
    throw new Error(message);
  }
}

function workspaceAppUploadSessionUrl(
  baseUrl: string,
  context: WorkspaceAppGuestContext
): URL {
  return new URL(workspaceAppUploadSessionPath(context), baseUrl);
}

function workspaceAppUploadSessionPath(
  context: WorkspaceAppGuestContext
): string {
  return `/v1/workspaces/${encodeURIComponent(context.workspaceID)}/apps/${encodeURIComponent(context.appID)}/uploads`;
}

function normalizeWorkspaceAppUploadPrepareInput(
  payload: unknown
): DesktopWorkspaceAppFileUploadPrepareInput {
  if (!isRecord(payload)) {
    throw new Error("files.upload prepare input must be an object.");
  }
  const input = normalizeTuttiExternalFileUploadInput(payload);
  if (!input.name) {
    throw new Error("files.upload name is required.");
  }
  if (!input.mimeType) {
    throw new Error("files.upload mimeType is required.");
  }
  if (
    typeof payload.sizeBytes !== "number" ||
    !Number.isFinite(payload.sizeBytes) ||
    payload.sizeBytes < 0
  ) {
    throw new Error("files.upload sizeBytes must be a non-negative number.");
  }
  return {
    purpose: input.purpose,
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: payload.sizeBytes
  };
}

function normalizeWorkspaceAppUploadCompleteInput(
  payload: unknown
): DesktopWorkspaceAppFileUploadCompleteInput {
  return { uploadId: normalizeWorkspaceAppUploadID(payload, "complete") };
}

function normalizeWorkspaceAppUploadCancelInput(
  payload: unknown
): DesktopWorkspaceAppFileUploadCancelInput {
  return { uploadId: normalizeWorkspaceAppUploadID(payload, "cancel") };
}

function normalizeWorkspaceAppUploadID(
  payload: unknown,
  operation: "cancel" | "complete"
): string {
  if (!isRecord(payload)) {
    throw new Error(`files.upload ${operation} input must be an object.`);
  }
  const uploadId =
    typeof payload.uploadId === "string" ? payload.uploadId.trim() : "";
  if (!uploadId) {
    throw new Error("files.upload uploadId is required.");
  }
  return uploadId;
}

function normalizeWorkspaceAppUploadPrepareResponse(value: unknown): {
  expiresAt: string;
  uploadId: string;
} {
  if (
    !isRecord(value) ||
    typeof value.uploadId !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    throw new Error("Workspace app upload prepare response is invalid.");
  }
  return {
    expiresAt: value.expiresAt,
    uploadId: value.uploadId
  };
}

function normalizeWorkspaceAppUploadCompleteResponse(
  value: unknown
): TuttiExternalUploadedFile {
  if (!isRecord(value)) {
    throw new Error("Workspace app upload complete response is invalid.");
  }
  return normalizeWorkspaceAppUploadedFile(value.file);
}

function normalizeWorkspaceAppUploadedFile(
  value: unknown
): TuttiExternalUploadedFile {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.name !== "string" ||
    typeof value.mimeType !== "string" ||
    typeof value.sha256 !== "string" ||
    typeof value.sizeBytes !== "number" ||
    !Number.isFinite(value.sizeBytes)
  ) {
    throw new Error("Workspace app uploaded file response is invalid.");
  }
  return {
    path: value.path,
    name: value.name,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256
  };
}

async function readWorkspaceAppUploadError(
  response: Response,
  operation: string
): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload)) {
      if (typeof payload.error === "string") {
        return payload.error;
      }
      if (typeof payload.message === "string") {
        return payload.message;
      }
      if (isRecord(payload.error)) {
        const error = payload.error;
        if (typeof error.developerMessage === "string") {
          return error.developerMessage;
        }
        if (typeof error.message === "string") {
          return error.message;
        }
        if (typeof error.reason === "string") {
          return error.reason;
        }
      }
    }
  } catch {
    // Keep the status fallback when the daemon does not return JSON.
  }
  return `${operation} failed with status ${response.status}.`;
}

async function requestManagedAiModelPermission(
  endpoint: DesktopDaemonEndpoint,
  context: WorkspaceAppGuestContext,
  input: TuttiExternalPermissionRequestInput
): Promise<TuttiExternalPermissionRequestResult> {
  const baseUrl = resolveDesktopDaemonBaseUrl(endpoint);
  const issuer = new URL(baseUrl).origin;
  const installationId = `${context.workspaceID}:${context.appID}`;
  const contextToken = createWorkspaceAppContextToken(endpoint, context, {
    installationId,
    issuer
  });
  // oxlint-disable-next-line no-restricted-globals -- talks to the local daemon, not outbound
  const response = await fetch(
    new URL(
      `/v1/workspaces/${encodeURIComponent(context.workspaceID)}/apps/${encodeURIComponent(context.appID)}/managed-model-grants`,
      baseUrl
    ),
    {
      body: JSON.stringify({
        contextToken,
        nonce: input.nonce,
        providers: input.providers ?? [],
        scopes: input.scopes,
        state: input.state
      }),
      headers: {
        Authorization: `Bearer ${endpoint.accessToken}`,
        "Content-Type": "application/json"
      },
      method: "POST"
    }
  );
  if (!response.ok) {
    const message = await readManagedAiModelGrantError(response);
    throw new Error(message);
  }
  const payload: unknown = await response.json();
  return {
    ...normalizeManagedAiModelPermissionResponse(payload),
    contextToken
  };
}

async function readManagedAiModelGrantError(
  response: Response
): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof payload.error === "string") {
      return payload.error;
    }
    if (isRecord(payload) && typeof payload.message === "string") {
      return payload.message;
    }
  } catch {
    // Keep the status fallback when the daemon does not return JSON.
  }
  return `Managed AI model permission request failed with status ${response.status}.`;
}

function normalizeManagedAiModelPermissionResponse(
  value: unknown
): TuttiExternalPermissionRequestResult {
  if (!isRecord(value) || typeof value.grantCode !== "string") {
    throw new Error("Managed AI model permission response is invalid.");
  }
  return {
    code: value.grantCode,
    ...(typeof value.contextToken === "string"
      ? { contextToken: value.contextToken }
      : {}),
    ...(typeof value.expiresAt === "string"
      ? { expiresAt: value.expiresAt }
      : {}),
    ...(Array.isArray(value.models)
      ? { models: normalizeManagedAiModels(value.models) }
      : {}),
    ...(Array.isArray(value.providers)
      ? { providers: normalizeManagedAiModelProviderIds(value.providers) }
      : {})
  };
}

function normalizeManagedAiModels(
  values: unknown[]
): TuttiExternalManagedAiModel[] {
  return values.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      !isTuttiExternalManagedAiModelProviderId(value.provider)
    ) {
      throw new Error("Managed AI model permission response model is invalid.");
    }
    return {
      id: value.id,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      provider: value.provider
    };
  });
}

function normalizeManagedAiModelProviderIds(
  values: unknown[]
): TuttiExternalManagedAiModelProviderId[] {
  return values.map((value) => {
    if (!isTuttiExternalManagedAiModelProviderId(value)) {
      throw new Error(
        "Managed AI model permission response provider is invalid."
      );
    }
    return value;
  });
}

function isWorkspaceAppExternalRendererResponse(
  value: unknown,
  requestId: string
): value is DesktopWorkspaceAppExternalRendererResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { requestId?: unknown }).requestId === requestId &&
    isDesktopIpcResult((value as { result?: unknown }).result)
  );
}

function isDesktopIpcResult(
  value: unknown
): value is DesktopIpcResult<DesktopWorkspaceAppExternalRendererResult> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const ok = (value as { ok?: unknown }).ok;
  if (ok === true) {
    return "data" in value;
  }
  return (
    ok === false &&
    typeof (value as { error?: { message?: unknown } }).error?.message ===
      "string"
  );
}

function createWorkspaceAppContext(
  endpoint: DesktopDaemonEndpoint,
  locale: DesktopLocale,
  context: WorkspaceAppGuestContext | undefined
): DesktopWorkspaceAppContext {
  if (!context) {
    return { locale };
  }
  const issuer = new URL(resolveDesktopDaemonBaseUrl(endpoint)).origin;
  const installationId = `${context.workspaceID}:${context.appID}`;
  const launchIntent = context.launchIntent;
  delete context.launchIntent;
  return {
    appId: context.appID,
    capabilities: [
      "browser.openUrl@1",
      "files.open@1",
      "files.upload@1",
      "pdf.printHtmlToPdf@1",
      "userProjects@1",
      "workspace.openFeature@1"
    ],
    contextToken: createWorkspaceAppContextToken(endpoint, context, {
      installationId,
      issuer
    }),
    installationId,
    issuer,
    ...(launchIntent ? { launchIntent } : {}),
    locale,
    workspaceId: context.workspaceID
  };
}

function createWorkspaceAppContextToken(
  endpoint: DesktopDaemonEndpoint,
  context: WorkspaceAppGuestContext,
  input: { installationId: string; issuer: string }
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    appId: context.appID,
    aud: context.appID,
    exp: nowSeconds + 5 * 60,
    iat: nowSeconds,
    installationId: input.installationId,
    iss: input.issuer,
    workspaceId: context.workspaceID
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const appToken = createAppServerToken(
    endpoint.accessToken,
    context.workspaceID,
    context.appID
  );
  const signature = createHmac("sha256", appToken)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function createAppServerToken(
  accessToken: string,
  workspaceID: string,
  appID: string
): string {
  const mac = createHmac("sha256", accessToken.trim());
  mac.update(workspaceID.trim());
  mac.update(Buffer.from([0]));
  mac.update(appID.trim());
  return `tutti-app-v1.${mac.digest("base64url")}`;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function readWorkspaceAppGuestContext(
  ownerWindow: BrowserWindow,
  partition: string | null | undefined
): WorkspaceAppGuestContext | null {
  const prefix = "persist:tutti-app:";
  if (!partition?.startsWith(prefix)) {
    return null;
  }
  const value = partition.slice(prefix.length);
  const separator = value.indexOf(":");
  if (separator <= 0 || separator >= value.length - 1) {
    return null;
  }
  const workspaceID = decodeURIComponent(value.slice(0, separator));
  const appID = decodeURIComponent(value.slice(separator + 1));
  const intentKey = workspaceAppInitialLaunchIntentKey({
    appID,
    ownerWebContentsId: ownerWindow.webContents.id,
    workspaceID
  });
  const launchIntent = workspaceAppInitialLaunchIntents.get(intentKey);
  workspaceAppInitialLaunchIntents.delete(intentKey);
  return {
    ...(launchIntent ? { launchIntent } : {}),
    appID,
    ownerWindow,
    workspaceID
  };
}

function workspaceAppInitialLaunchIntentKey(input: {
  appID: string;
  ownerWebContentsId: number;
  workspaceID: string;
}): string {
  return [
    String(input.ownerWebContentsId),
    encodeURIComponent(input.workspaceID),
    encodeURIComponent(input.appID)
  ].join(":");
}

function isWorkspaceAppDiagnosticPayload(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkspaceAppExternalRendererEvent(
  value: unknown
): value is DesktopWorkspaceAppExternalRendererEvent {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.workspaceId !== "string") {
    return false;
  }
  if (value.type === "workspace.launchIntent") {
    return (
      typeof value.appId === "string" &&
      isWorkspaceAppOpenRouteIntent(value.intent)
    );
  }
  if (value.type === "at.invalidated") {
    try {
      normalizeTuttiExternalAtInvalidation(value.invalidation);
      return true;
    } catch {
      return false;
    }
  }
  if (value.type !== "userProjects.changed") {
    return false;
  }
  if (!isRecord(value.snapshot)) {
    return false;
  }
  const snapshot = value.snapshot;
  return (
    (typeof snapshot.error === "string" || snapshot.error === null) &&
    typeof snapshot.initialized === "boolean" &&
    typeof snapshot.isLoading === "boolean" &&
    Array.isArray(snapshot.projects) &&
    typeof snapshot.revision === "number"
  );
}

function isWorkspaceAppOpenRouteIntent(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind !== "open-route" || typeof value.route !== "string") {
    return false;
  }
  const route = value.route.trim();
  if (
    !route.startsWith("/") ||
    route.startsWith("//") ||
    route.includes("://")
  ) {
    return false;
  }
  if (value.params !== undefined && !isStringRecord(value.params)) {
    return false;
  }
  if (value.state !== undefined && !isRecord(value.state)) {
    return false;
  }
  return true;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkspaceAppOpenUrlPayload(
  value: unknown
): value is { url: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { url?: unknown }).url === "string"
  );
}

function normalizeWorkspaceAppOpenUrlLogPayload(
  value: unknown
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const url = (value as { url?: unknown }).url;
  return {
    hasUrl: typeof url === "string" && url.trim().length > 0,
    url: typeof url === "string" ? url : null
  };
}

function broadcastWorkspaceAppContext(
  payload: Partial<DesktopWorkspaceAppContext>
): void {
  for (const contents of [...workspaceAppGuestWebContents]) {
    if (contents.isDestroyed()) {
      workspaceAppGuestWebContents.delete(contents);
      continue;
    }
    contents.send(desktopIpcChannels.appContext.changed, payload);
  }
}

function toWorkspaceAppOpenFileRequest(
  input: TuttiExternalFileOpenInput,
  payload: unknown
): DesktopWorkspaceAppOpenFileRequest {
  const request: DesktopWorkspaceAppOpenFileRequest = { ...input };
  if (!isRecord(payload)) {
    return request;
  }

  const location = payload.location;
  if (isRecord(location) && typeof location.path === "string") {
    const locationType = location.type;
    if (
      locationType === "app-data-relative" ||
      locationType === "app-package-relative" ||
      locationType === "workspace-relative"
    ) {
      request.location = {
        path: location.path.trim(),
        type: locationType
      };
    }
  }

  if (
    typeof payload.packageVersion === "string" ||
    payload.packageVersion === null
  ) {
    request.packageVersion = payload.packageVersion;
  }

  return request;
}
