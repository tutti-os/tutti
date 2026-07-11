import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  DesktopIpcResult,
  DesktopWorkspaceAppContext,
  DesktopWorkspaceAppContextPatch,
  DesktopWorkspaceAppExternalRendererEvent
} from "../../shared/contracts/ipc";
import type { TuttiExternalWorkspaceOpenRouteIntent } from "@tutti-os/workspace-external-core/contracts";
import { normalizeTuttiExternalWorkspaceOpenRouteIntent } from "@tutti-os/workspace-external-core/core";
import { createWorkspaceAppExternalBridge } from "./workspaceAppExternalBridge.ts";
import { DesktopApiError } from "../api/desktopApiError.ts";
import { installWorkspaceAppInteractionForwarding } from "./workspaceAppInteractionForwarding.ts";
import { installWorkspaceAppLinkInterception } from "./workspaceAppLinks.ts";
import { createWorkspaceAppUserProjectSnapshotBridge } from "./workspaceAppUserProjectSnapshots.ts";
import {
  createWorkspaceAppContextStore,
  isWorkspaceAppContext,
  isWorkspaceAppContextPatch
} from "./workspaceAppContextStore.ts";

const appContextChannels = {
  changed: "workspace-app-context:changed",
  diagnostic: "workspace-app-context:diagnostic",
  get: "workspace-app-context:get"
} as const;
const maxPendingWorkspaceAppLaunchIntents = 64;

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

  const launchIntentListeners = new Set<
    (intent: TuttiExternalWorkspaceOpenRouteIntent) => void
  >();
  const pendingLaunchIntents: TuttiExternalWorkspaceOpenRouteIntent[] = [];
  const userProjectSnapshots = createWorkspaceAppUserProjectSnapshotBridge();
  const contextStore = createWorkspaceAppContextStore({
    load: resolveHostContext
  });
  const appContext: WorkspaceAppHostContext = {
    get: contextStore.get,
    subscribe(listener) {
      const unsubscribe = contextStore.subscribe(listener);
      void contextStore.get().catch((error: unknown) => {
        sendDiagnostic("subscribe-replay-failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
      return unsubscribe;
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
    subscribeToWorkspaceLaunchIntents(listener) {
      launchIntentListeners.add(listener);
      for (const intent of pendingLaunchIntents.splice(0)) {
        listener(intent);
      }
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
    (_event: IpcRendererEvent, payload: DesktopWorkspaceAppContextPatch) => {
      if (isWorkspaceAppContextPatch(payload)) {
        contextStore.publish(payload);
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
      if (payload.type === "workspace.launchIntent") {
        if (launchIntentListeners.size === 0) {
          pendingLaunchIntents.push(payload.intent);
          while (
            pendingLaunchIntents.length > maxPendingWorkspaceAppLaunchIntents
          ) {
            pendingLaunchIntents.shift();
          }
          return;
        }
        for (const listener of [...launchIntentListeners]) {
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
    if (!result.ok) {
      throw new DesktopApiError(result.error);
    }
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
    throw new DesktopApiError(result.error);
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

function isWorkspaceAppExternalRendererEvent(
  value: unknown
): value is DesktopWorkspaceAppExternalRendererEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "userProjects.changed") {
    return (
      record.type === "workspace.launchIntent" &&
      typeof record.workspaceId === "string" &&
      typeof record.appId === "string" &&
      isWorkspaceAppOpenRouteIntent(record.intent)
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
  try {
    normalizeTuttiExternalWorkspaceOpenRouteIntent(value);
    return true;
  } catch {
    return false;
  }
}
