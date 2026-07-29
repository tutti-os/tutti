import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";
import {
  normalizeTuttiExternalAtQueryInput,
  normalizeTuttiExternalAtResolveInput,
  normalizeTuttiExternalLogInput,
  normalizeTuttiExternalReferenceOpenInput,
  normalizeTuttiExternalSettingsOpenInput,
  normalizeTuttiExternalWorkspaceOpenFeatureInput
} from "@tutti-os/workspace-external-core/core";
import type {
  TuttiExternalAtQueryResult,
  TuttiExternalAtResolveResult
} from "@tutti-os/workspace-external-core/contracts";
import type { DesktopHostPreferencesState } from "../desktopHostPreferences";
import type { DesktopLogger } from "../logging";
import type { DesktopDaemonEndpoint } from "../transport/paths";
import { registerDesktopIpcHandler } from "./handle.ts";
import {
  broadcastWorkspaceAppContext,
  createWorkspaceAppContext,
  forwardWorkspaceAppExternalRendererEvent,
  getWorkspaceAppGuestContext,
  isWorkspaceAppExternalRendererEvent,
  isWorkspaceAppGuestWebContents,
  requireWorkspaceAppGuestContext
} from "./workspaceAppGuestContextRegistry.ts";
import {
  normalizeWorkspaceAppDiagnosticLogRecord,
  type WorkspaceAppFrontendLogWriter
} from "./workspaceAppFrontendLogging.ts";
import { dispatchWorkspaceAppOpenUrl } from "./workspaceAppWindowOpen.ts";
import { isRecord } from "./workspaceAppPayloadValidation.ts";
import { requestWorkspaceAppExternalRenderer } from "./workspaceAppRendererBridge.ts";

export function registerWorkspaceAppShellIpc(input: {
  endpoint: DesktopDaemonEndpoint;
  logWriter: WorkspaceAppFrontendLogWriter;
  logger?: DesktopLogger;
  preferences: DesktopHostPreferencesState;
}): void {
  const { endpoint, logger, logWriter, preferences } = input;
  registerDesktopIpcHandler(desktopIpcChannels.appContext.get, (event) =>
    createWorkspaceAppContext(
      endpoint,
      preferences.getLocale(),
      getWorkspaceAppGuestContext(event.sender.id)
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
  ipcMain.on(
    desktopIpcChannels.appContext.diagnostic,
    (event, payload: unknown) => {
      const normalizedPayload = isWorkspaceAppDiagnosticPayload(payload)
        ? payload
        : null;
      writeWorkspaceAppDiagnosticLog(
        logWriter,
        event.sender.id,
        normalizedPayload
      );
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
      const context = getWorkspaceAppGuestContext(event.sender.id);
      if (
        !context ||
        !isWorkspaceAppGuestWebContents(event.sender) ||
        event.sender.isDestroyed()
      ) {
        return;
      }

      try {
        const input = normalizeTuttiExternalLogInput(payload);
        logWriter.write(event.sender.id, context, input);
      } catch {
        // Fire-and-forget: invalid app payloads are silently ignored.
      }
    }
  );
  ipcMain.on(desktopIpcChannels.appContext.openUrl, (event, payload) => {
    const context = getWorkspaceAppGuestContext(event.sender.id);
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

function writeWorkspaceAppDiagnosticLog(
  logWriter: WorkspaceAppFrontendLogWriter,
  guestWebContentsId: number,
  payload: Record<string, unknown> | null
): void {
  if (!payload) {
    return;
  }

  const context = getWorkspaceAppGuestContext(guestWebContentsId);
  const record = normalizeWorkspaceAppDiagnosticLogRecord(payload);
  if (!context || !record) {
    return;
  }

  logWriter.write(guestWebContentsId, context, record);
}

function isWorkspaceAppDiagnosticPayload(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkspaceAppOpenUrlPayload(
  value: unknown
): value is { url: string } {
  return isRecord(value) && typeof value.url === "string";
}

function normalizeWorkspaceAppOpenUrlLogPayload(
  value: unknown
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const url = value.url;
  return {
    hasUrl: typeof url === "string" && url.trim().length > 0,
    url: typeof url === "string" ? url : null
  };
}
