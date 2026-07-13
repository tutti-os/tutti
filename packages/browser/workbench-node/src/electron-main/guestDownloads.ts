import type {
  BrowserNodeDownloadActionInput,
  BrowserNodeDownloadState,
  BrowserNodeEvent
} from "../core/types.ts";
import type {
  BrowserGuestDownloadItem,
  BrowserGuestDownloadItemState,
  BrowserGuestElectronSession,
  BrowserGuestWillDownloadListener
} from "./types.ts";

interface BrowserDownloadRecord {
  item: BrowserGuestDownloadItem;
  listeners: Array<{
    event: string;
    listener: (...args: unknown[]) => void;
  }>;
  nodeId: string;
}

export interface BrowserGuestDownloadController {
  attach(electronSession: BrowserGuestElectronSession): void;
  dispose(): void;
  perform(input: BrowserNodeDownloadActionInput): Promise<void>;
}

export function createBrowserGuestDownloadController(input: {
  emit: (event: BrowserNodeEvent) => void;
  getNodeIdByWebContentsId: (webContentsId: number) => string | undefined;
  openDownloadedFile?: (path: string) => Promise<void> | void;
  showDownloadedFile?: (path: string) => Promise<void> | void;
}): BrowserGuestDownloadController {
  const records = new Map<string, BrowserDownloadRecord>();
  const listenersBySession = new Map<
    BrowserGuestElectronSession,
    BrowserGuestWillDownloadListener
  >();
  let nextDownloadId = 1;

  const publish = (
    nodeId: string,
    downloadId: string,
    item: BrowserGuestDownloadItem,
    state?: BrowserGuestDownloadItemState
  ): void => {
    input.emit({
      download: createBrowserNodeDownloadState(downloadId, item, state),
      nodeId,
      type: "download"
    });
  };

  return {
    attach(electronSession) {
      if (listenersBySession.has(electronSession)) {
        return;
      }
      const listener: BrowserGuestWillDownloadListener = (
        _event,
        item,
        sourceContents
      ) => {
        const sourceId = sourceContents.id;
        const nodeId =
          typeof sourceId === "number"
            ? input.getNodeIdByWebContentsId(sourceId)
            : undefined;
        if (!nodeId) {
          return;
        }

        const downloadId = `download-${nextDownloadId}`;
        nextDownloadId += 1;
        const onUpdated = (...args: unknown[]) => {
          publish(
            nodeId,
            downloadId,
            item,
            isBrowserDownloadItemState(args[1]) ? args[1] : undefined
          );
        };
        const onDone = (...args: unknown[]) => {
          publish(
            nodeId,
            downloadId,
            item,
            isBrowserDownloadItemState(args[1]) ? args[1] : undefined
          );
        };
        const itemListeners = [
          { event: "updated", listener: onUpdated },
          { event: "done", listener: onDone }
        ];
        for (const record of itemListeners) {
          item.on(record.event, record.listener);
        }
        records.set(downloadId, {
          item,
          listeners: itemListeners,
          nodeId
        });
        publish(nodeId, downloadId, item);
      };
      electronSession.on("will-download", listener);
      listenersBySession.set(electronSession, listener);
    },
    dispose() {
      for (const [electronSession, listener] of listenersBySession) {
        electronSession.off("will-download", listener);
      }
      for (const record of records.values()) {
        for (const listener of record.listeners) {
          record.item.off(listener.event, listener.listener);
        }
      }
      listenersBySession.clear();
      records.clear();
    },
    async perform(actionInput) {
      const record = records.get(actionInput.downloadId);
      if (!record || record.nodeId !== actionInput.nodeId) {
        return;
      }
      const path = record.item.getSavePath().trim();
      switch (actionInput.action) {
        case "cancel":
          record.item.cancel();
          break;
        case "pause":
          record.item.pause();
          break;
        case "resume":
          record.item.resume();
          break;
        case "open":
          if (path && input.openDownloadedFile) {
            await Promise.resolve(input.openDownloadedFile(path));
          }
          break;
        case "show-in-folder":
          if (path && input.showDownloadedFile) {
            await Promise.resolve(input.showDownloadedFile(path));
          }
          break;
      }
      publish(record.nodeId, actionInput.downloadId, record.item);
    }
  };
}

function createBrowserNodeDownloadState(
  id: string,
  item: BrowserGuestDownloadItem,
  state: BrowserGuestDownloadItemState | undefined
): BrowserNodeDownloadState {
  return {
    canResume: item.canResume(),
    fileName: item.getFilename(),
    filePath: item.getSavePath().trim() || null,
    id,
    receivedBytes: item.getReceivedBytes(),
    status: item.isPaused() ? "paused" : (state ?? item.getState()),
    totalBytes: item.getTotalBytes(),
    url: item.getURL()
  };
}

function isBrowserDownloadItemState(
  value: unknown
): value is BrowserGuestDownloadItemState {
  return (
    value === "progressing" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}
