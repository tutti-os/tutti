import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  DesktopIpcResult,
  DesktopWorkspaceAppContext
} from "../../shared/contracts/ipc";
import { createWorkspaceAppExternalBridge } from "./workspaceAppExternalBridge.ts";
import { installWorkspaceAppLinkInterception } from "./workspaceAppLinks.ts";

const appContextChannels = {
  changed: "workspace-app-context:changed",
  diagnostic: "workspace-app-context:diagnostic",
  get: "workspace-app-context:get"
} as const;

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

export interface WorkspaceAppHostContext {
  get(): Promise<DesktopWorkspaceAppContext>;
  subscribe(
    listener: (context: DesktopWorkspaceAppContext) => void
  ): () => void;
}

const contextListeners = new Set<
  (context: DesktopWorkspaceAppContext) => void
>();
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

function isWorkspaceAppContext(
  value: unknown
): value is DesktopWorkspaceAppContext {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DesktopWorkspaceAppContext).locale === "string"
  );
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
