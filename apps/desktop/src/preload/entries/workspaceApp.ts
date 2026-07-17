import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  DesktopIpcResult,
  DesktopWorkspaceAppContext,
  DesktopWorkspaceAppExternalRendererEvent
} from "../../shared/contracts/ipc";
import type {
  TuttiExternalAtInvalidation,
  TuttiExternalWorkspaceOpenRouteIntent
} from "@tutti-os/workspace-external-core/contracts";
import { createWorkspaceAppExternalBridge } from "./workspaceAppExternalBridge.ts";
import { installWorkspaceAppInteractionForwarding } from "./workspaceAppInteractionForwarding.ts";
import { installWorkspaceAppLinkInterception } from "./workspaceAppLinks.ts";
import { createWorkspaceAppUserProjectSnapshotBridge } from "./workspaceAppUserProjectSnapshots.ts";

const appContextChannels = {
  changed: "workspace-app-context:changed",
  diagnostic: "workspace-app-context:diagnostic",
  get: "workspace-app-context:get"
} as const;

installWorkspaceAppInteractionForwarding({
  scope: globalThis.window,
  sendToHost(channel, payload) {
    ipcRenderer.sendToHost(channel, payload);
  }
});

// Subframes only need passive interaction pings; keep host APIs main-frame only.
if (process.isMainFrame) {
  installWorkspaceAppMainFrameBridge();
}

export interface WorkspaceAppHostContext {
  get(): Promise<DesktopWorkspaceAppContext>;
  subscribe(
    listener: (context: DesktopWorkspaceAppContext) => void
  ): () => void;
}

function installWorkspaceAppMainFrameBridge(): void {
  installWorkspaceAppLinkInterception({
    executeInMainWorld(script) {
      const result = contextBridge.executeInMainWorld(script) as unknown;
      return result;
    },
    reportDiagnostic(diagnostic) {
      ipcRenderer.send(appContextChannels.diagnostic, {
        event: "workspace-app-link-interception",
        ...diagnostic
      });
    },
    scope: globalThis.window,
    send(channel, payload) {
      ipcRenderer.send(channel, payload);
    }
  });

  const contextListeners = new Set<
    (context: DesktopWorkspaceAppContext) => void
  >();
  const launchIntentListeners = new Set<
    (intent: TuttiExternalWorkspaceOpenRouteIntent) => void
  >();
  const atInvalidationListeners = new Set<
    (event: TuttiExternalAtInvalidation) => void
  >();
  const userProjectSnapshots = createWorkspaceAppUserProjectSnapshotBridge();
  let cachedContext: DesktopWorkspaceAppContext | null = null;
  let pendingContext: Promise<DesktopWorkspaceAppContext> | null = null;

  const appContext: WorkspaceAppHostContext = {
    async get() {
      if (cachedContext) {
        return cachedContext;
      }
      if (pendingContext) {
        return pendingContext;
      }

      pendingContext = resolveHostContext();
      try {
        const context = await pendingContext;
        cachedContext = context;
        return context;
      } finally {
        pendingContext = null;
      }
    },
    subscribe(listener) {
      contextListeners.add(listener);
      void appContext
        .get()
        .then((context) => {
          if (contextListeners.has(listener)) {
            listener(context);
          }
        })
        .catch((error: unknown) => {
          sendDiagnostic("subscribe-replay-failed", {
            message: error instanceof Error ? error.message : String(error)
          });
        });

      return () => {
        contextListeners.delete(listener);
      };
    }
  };

  const tuttiExternal = createWorkspaceAppExternalBridge({
    appContext,
    invoke: invokeWorkspaceApp,
    isUserActivationActive: () =>
      globalThis.navigator.userActivation?.isActive === true,
    send(channel, payload) {
      ipcRenderer.send(channel, payload);
    },
    subscribeToAtInvalidations(listener) {
      atInvalidationListeners.add(listener);
      return () => {
        atInvalidationListeners.delete(listener);
      };
    },
    subscribeToWorkspaceLaunchIntents(listener) {
      launchIntentListeners.add(listener);
      return () => {
        launchIntentListeners.delete(listener);
      };
    },
    subscribeToUserProjects(listener) {
      return userProjectSnapshots.subscribe(listener);
    }
  });

  ipcRenderer.on(
    appContextChannels.changed,
    (_event: IpcRendererEvent, payload: DesktopWorkspaceAppContext) => {
      if (isWorkspaceAppContext(payload)) {
        cachedContext = payload;
        for (const listener of contextListeners) {
          listener(payload);
        }
      }
    }
  );

  ipcRenderer.on(
    "workspace-app-external:guest-event",
    (_event: IpcRendererEvent, payload: unknown) => {
      if (!isWorkspaceAppExternalRendererEvent(payload)) {
        return;
      }
      if (payload.type === "userProjects.changed") {
        userProjectSnapshots.publish(payload.snapshot);
        return;
      }
      if (payload.type === "at.invalidated") {
        for (const listener of atInvalidationListeners) {
          listener(payload.invalidation);
        }
        return;
      }
      if (payload.type === "workspace.launchIntent") {
        for (const listener of launchIntentListeners) {
          listener(payload.intent);
        }
      }
    }
  );

  async function resolveHostContext(): Promise<DesktopWorkspaceAppContext> {
    const result = await invokeWorkspaceAppRaw<DesktopWorkspaceAppContext>(
      appContextChannels.get
    );
    if (result.ok && isWorkspaceAppContext(result.data)) {
      return result.data;
    }

    const message = result.ok
      ? "invalid workspace app context"
      : result.error.message;
    sendDiagnostic("get-context-failed", { message });
    throw new Error(message);
  }

  async function invokeWorkspaceApp<TResult>(
    channel: string,
    payload?: unknown
  ): Promise<TResult> {
    const result = await invokeWorkspaceAppRaw<TResult>(channel, payload);
    if (result.ok) {
      return result.data;
    }
    throw new Error(result.error.message);
  }

  async function invokeWorkspaceAppRaw<TResult>(
    channel: string,
    payload?: unknown
  ): Promise<DesktopIpcResult<TResult>> {
    return (
      payload === undefined
        ? await ipcRenderer.invoke(channel)
        : await ipcRenderer.invoke(channel, payload)
    ) as DesktopIpcResult<TResult>;
  }

  contextBridge.exposeInMainWorld("tuttiExternal", tuttiExternal);

  function sendDiagnostic(
    event: string,
    details?: Record<string, unknown>
  ): void {
    ipcRenderer.send(appContextChannels.diagnostic, {
      details: details ?? {},
      event
    });
  }
}

function isWorkspaceAppContext(
  value: unknown
): value is DesktopWorkspaceAppContext {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DesktopWorkspaceAppContext).locale === "string"
  );
}

function isWorkspaceAppExternalRendererEvent(
  value: unknown
): value is DesktopWorkspaceAppExternalRendererEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "userProjects.changed") {
    return (
      (record.type === "workspace.launchIntent" &&
        typeof record.workspaceId === "string" &&
        typeof record.appId === "string" &&
        isWorkspaceAppOpenRouteIntent(record.intent)) ||
      (record.type === "at.invalidated" &&
        typeof record.workspaceId === "string" &&
        typeof record.invalidation === "object" &&
        record.invalidation !== null)
    );
  }
  if (typeof record.workspaceId !== "string") {
    return false;
  }
  const snapshot = record.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return false;
  }
  const snapshotRecord = snapshot as Record<string, unknown>;
  return (
    (typeof snapshotRecord.error === "string" ||
      snapshotRecord.error === null) &&
    typeof snapshotRecord.initialized === "boolean" &&
    typeof snapshotRecord.isLoading === "boolean" &&
    Array.isArray(snapshotRecord.projects) &&
    typeof snapshotRecord.revision === "number"
  );
}

function isWorkspaceAppOpenRouteIntent(
  value: unknown
): value is TuttiExternalWorkspaceOpenRouteIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "open-route" || typeof record.route !== "string") {
    return false;
  }
  const route = record.route.trim();
  if (
    !route.startsWith("/") ||
    route.startsWith("//") ||
    route.includes("://")
  ) {
    return false;
  }
  if (record.params !== undefined && !isStringRecord(record.params)) {
    return false;
  }
  if (
    record.state !== undefined &&
    (!record.state ||
      typeof record.state !== "object" ||
      Array.isArray(record.state))
  ) {
    return false;
  }
  return true;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}
