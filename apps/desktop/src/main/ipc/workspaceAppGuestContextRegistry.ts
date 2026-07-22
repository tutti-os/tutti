import electron, { type BrowserWindow, type WebContents } from "electron";
import {
  desktopIpcChannels,
  type DesktopWorkspaceAppContext,
  type DesktopWorkspaceAppExternalRendererEvent
} from "../../shared/contracts/ipc.ts";
import { normalizeTuttiExternalAtInvalidation } from "@tutti-os/workspace-external-core/core";
import type { TuttiExternalWorkspaceOpenRouteIntent } from "@tutti-os/workspace-external-core/contracts";
import type { DesktopLocale } from "../../shared/i18n";
import type { DesktopLogger } from "../logging";
import {
  resolveDesktopDaemonBaseUrl,
  type DesktopDaemonEndpoint
} from "../transport/paths.ts";
import { createWorkspaceAppContextToken } from "./workspaceAppContextToken.ts";
import type { WorkspaceAppGuestContext } from "./workspaceAppContextTypes.ts";
import { isRecord, isStringRecord } from "./workspaceAppPayloadValidation.ts";
import { installWorkspaceAppWindowOpenHandler } from "./workspaceAppWindowOpen.ts";

const { webContents } = electron;

const workspaceAppGuestWebContents = new Set<WebContents>();
const workspaceAppGuestContexts = new Map<number, WorkspaceAppGuestContext>();
const workspaceAppInitialLaunchIntents = new Map<
  string,
  TuttiExternalWorkspaceOpenRouteIntent
>();

export function registerWorkspaceAppGuestContext(input: {
  contents: WebContents;
  logger?: DesktopLogger;
  onDestroyed?: (webContentsId: number) => void;
  ownerWindow: BrowserWindow;
  partition?: string | null;
}): void {
  const { contents, logger, onDestroyed, ownerWindow, partition } = input;
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
    onDestroyed?.(contents.id);
  });
}

export function getWorkspaceAppGuestContext(
  webContentsId: number
): WorkspaceAppGuestContext | undefined {
  return workspaceAppGuestContexts.get(webContentsId);
}

export function isWorkspaceAppGuestWebContents(contents: WebContents): boolean {
  return workspaceAppGuestWebContents.has(contents);
}

export function requireWorkspaceAppGuestContext(
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

export function createWorkspaceAppContext(
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
      "agentActivity@1",
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

export function forwardWorkspaceAppExternalRendererEvent(
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

export function broadcastWorkspaceAppContext(
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

export function isWorkspaceAppExternalRendererEvent(
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
  return isWorkspaceAppUserProjectSnapshot(value.snapshot);
}

export function parseWorkspaceAppGuestPartition(
  partition: string | null | undefined
): { appID: string; workspaceID: string } | null {
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
    workspaceID: decodeURIComponent(value.slice(0, separator))
  };
}

function readWorkspaceAppGuestContext(
  ownerWindow: BrowserWindow,
  partition: string | null | undefined
): WorkspaceAppGuestContext | null {
  const parsed = parseWorkspaceAppGuestPartition(partition);
  if (!parsed) {
    return null;
  }
  const intentKey = workspaceAppInitialLaunchIntentKey({
    appID: parsed.appID,
    ownerWebContentsId: ownerWindow.webContents.id,
    workspaceID: parsed.workspaceID
  });
  const launchIntent = workspaceAppInitialLaunchIntents.get(intentKey);
  workspaceAppInitialLaunchIntents.delete(intentKey);
  return {
    ...(launchIntent ? { launchIntent } : {}),
    appID: parsed.appID,
    ownerWindow,
    workspaceID: parsed.workspaceID
  };
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

function isWorkspaceAppUserProjectSnapshot(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (typeof value.error === "string" || value.error === null) &&
    typeof value.initialized === "boolean" &&
    typeof value.isLoading === "boolean" &&
    Array.isArray(value.projects) &&
    typeof value.revision === "number"
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
