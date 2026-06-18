import {
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type WebContents
} from "electron";
import { createHmac, randomUUID } from "node:crypto";
import {
  desktopIpcChannels,
  type DesktopIpcResult,
  type DesktopWorkspaceAppExternalRendererRequest,
  type DesktopWorkspaceAppExternalRendererResponse,
  type DesktopWorkspaceAppExternalRendererResult,
  type DesktopWorkspaceAppContext,
  type DesktopWorkspaceAppOpenFileRequest
} from "../../shared/contracts/ipc";
import {
  normalizeTuttiExternalAtQueryInput,
  normalizeTuttiExternalFileOpenInput,
  normalizeTuttiExternalFileSelectInput,
  normalizeTuttiExternalLogInput,
  normalizeTuttiExternalPermissionRequestInput,
  normalizeTuttiExternalSettingsOpenInput,
  normalizeTuttiExternalWorkspaceOpenFeatureInput
} from "@tutti-os/workspace-external-core/core";
import type {
  TuttiExternalAtQueryResult,
  TuttiExternalFileOpenInput,
  TuttiExternalFileSelectResult,
  TuttiExternalManagedAiModel,
  TuttiExternalManagedAiModelProviderId,
  TuttiExternalPermissionRequestInput,
  TuttiExternalPermissionRequestResult
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
import {
  normalizeWorkspaceAppDiagnosticLogRecord,
  WorkspaceAppFrontendLogWriter,
  WorkspaceAppGuestLogRateLimiter
} from "./workspaceAppFrontendLogging.ts";
import { resolveWorkspaceAppOpenFilePayload } from "../host/workspaceAppFileOpen.ts";

const workspaceAppGuestWebContents = new Set<WebContents>();
const workspaceAppGuestContexts = new Map<number, WorkspaceAppGuestContext>();
let workspaceAppFrontendLogWriter: WorkspaceAppFrontendLogWriter | null = null;
let workspaceAppGuestLogRateLimiter: WorkspaceAppGuestLogRateLimiter | null =
  null;

interface WorkspaceAppGuestContext {
  appID: string;
  ownerWindow: BrowserWindow;
  workspaceID: string;
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
    desktopIpcChannels.appExternal.permissionsRequest,
    async (event, payload) => {
      const context = requireWorkspaceAppGuestContext(event.sender);
      const input = normalizeTuttiExternalPermissionRequestInput(payload);
      return requestManagedAiModelPermission(endpoint, context, input);
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
  preferences.subscribe(() => {
    broadcastWorkspaceAppContext({
      locale: preferences.getLocale()
    });
  });
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
  return normalizeManagedAiModelPermissionResponse(payload);
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
  return {
    appId: context.appID,
    capabilities: ["files.open@1", "workspace.openFeature@1"],
    contextToken: createWorkspaceAppContextToken(endpoint, context, {
      installationId,
      issuer
    }),
    installationId,
    issuer,
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
  return {
    appID: decodeURIComponent(value.slice(separator + 1)),
    ownerWindow,
    workspaceID: decodeURIComponent(value.slice(0, separator))
  };
}

function isWorkspaceAppDiagnosticPayload(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function broadcastWorkspaceAppContext(payload: { locale: string }): void {
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
