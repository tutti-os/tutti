import type { BrowserWindow, IpcMainEvent, WebContents } from "electron";
import {
  desktopIpcChannels,
  type DesktopWorkspaceAppExternalRendererReadiness
} from "../../shared/contracts/ipc.ts";

interface WorkspaceAppRendererReadinessIpc {
  off(
    channel: string,
    listener: (event: IpcMainEvent, payload: unknown) => void
  ): void;
  on(
    channel: string,
    listener: (event: IpcMainEvent, payload: unknown) => void
  ): void;
}

interface PendingRendererReadiness {
  reject(error: Error): void;
  resolve(): void;
}

export interface WorkspaceAppRendererReadiness {
  dispose(): void;
  waitFor(ownerWindow: BrowserWindow): Promise<void>;
}

export function createWorkspaceAppRendererReadiness(input: {
  ipc: WorkspaceAppRendererReadinessIpc;
  timeoutMs?: number;
}): WorkspaceAppRendererReadiness {
  const readyWebContentsIds = new Set<number>();
  const pendingByWebContentsId = new Map<
    number,
    Set<PendingRendererReadiness>
  >();
  const trackedWebContents = new Map<
    number,
    { dispose(): void; webContents: WebContents }
  >();
  const timeoutMs = input.timeoutMs ?? 30_000;
  let disposed = false;

  const handleReady = (event: IpcMainEvent, payload: unknown): void => {
    if (!isWorkspaceAppExternalRendererReadiness(payload)) {
      return;
    }
    const webContentsId = event.sender.id;
    if (!payload.ready) {
      readyWebContentsIds.delete(webContentsId);
      return;
    }
    trackWebContents(event.sender);
    readyWebContentsIds.add(webContentsId);
    const pending = pendingByWebContentsId.get(webContentsId);
    if (!pending) {
      return;
    }
    pendingByWebContentsId.delete(webContentsId);
    for (const waiter of pending) {
      waiter.resolve();
    }
  };

  input.ipc.on(desktopIpcChannels.appExternal.rendererReady, handleReady);

  function trackWebContents(webContents: WebContents): void {
    if (trackedWebContents.has(webContents.id)) {
      return;
    }
    const clearReady = (): void => {
      readyWebContentsIds.delete(webContents.id);
    };
    const handleDestroyed = (): void => {
      clearReady();
      trackedWebContents.get(webContents.id)?.dispose();
      trackedWebContents.delete(webContents.id);
    };
    const dispose = (): void => {
      webContents.off("destroyed", handleDestroyed);
      webContents.off("did-start-loading", clearReady);
      webContents.off("render-process-gone", clearReady);
    };
    webContents.on("destroyed", handleDestroyed);
    webContents.on("did-start-loading", clearReady);
    webContents.on("render-process-gone", clearReady);
    trackedWebContents.set(webContents.id, { dispose, webContents });
  }

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      input.ipc.off(desktopIpcChannels.appExternal.rendererReady, handleReady);
      readyWebContentsIds.clear();
      for (const tracked of trackedWebContents.values()) {
        tracked.dispose();
      }
      trackedWebContents.clear();
      for (const pending of pendingByWebContentsId.values()) {
        for (const waiter of pending) {
          waiter.reject(
            new Error("Workspace renderer readiness was disposed.")
          );
        }
      }
      pendingByWebContentsId.clear();
    },
    waitFor(ownerWindow) {
      const ownerWebContents = ownerWindow.webContents;
      if (disposed) {
        return Promise.reject(
          new Error("Workspace renderer readiness is unavailable.")
        );
      }
      if (ownerWebContents.isDestroyed()) {
        return Promise.reject(
          new Error("Workspace owner renderer is unavailable.")
        );
      }
      if (readyWebContentsIds.has(ownerWebContents.id)) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const webContentsId = ownerWebContents.id;
        const pending = pendingByWebContentsId.get(webContentsId) ?? new Set();
        pendingByWebContentsId.set(webContentsId, pending);

        const cleanup = (): void => {
          clearTimeout(timeout);
          ownerWebContents.off("destroyed", handleDestroyed);
          pending.delete(waiter);
          if (pending.size === 0) {
            pendingByWebContentsId.delete(webContentsId);
          }
        };
        const settle = (action: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          action();
        };
        const waiter: PendingRendererReadiness = {
          reject: (error) => settle(() => reject(error)),
          resolve: () => settle(resolve)
        };
        const handleDestroyed = (): void => {
          readyWebContentsIds.delete(webContentsId);
          waiter.reject(new Error("Workspace owner renderer is unavailable."));
        };
        const timeout = setTimeout(() => {
          waiter.reject(
            new Error("Workspace owner renderer did not become ready.")
          );
        }, timeoutMs);

        pending.add(waiter);
        ownerWebContents.once("destroyed", handleDestroyed);
      });
    }
  };
}

export function isWorkspaceAppExternalRendererReadiness(
  value: unknown
): value is DesktopWorkspaceAppExternalRendererReadiness {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { ready?: unknown }).ready === "boolean"
  );
}
