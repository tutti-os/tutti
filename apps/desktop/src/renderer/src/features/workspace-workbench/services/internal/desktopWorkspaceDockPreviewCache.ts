import type {
  WorkbenchDockPreviewCache,
  WorkbenchDockPreviewCacheKey
} from "@tutti-os/workbench-surface";
import type { DesktopDockPreviewCacheApi } from "@preload/types";

export function createDesktopWorkspaceDockPreviewCache(
  api: DesktopDockPreviewCacheApi
): WorkbenchDockPreviewCache {
  const pendingWriteKeys = new Set<string>();

  return {
    read(key) {
      return api
        .read({ key: desktopDockPreviewCacheKey(key) })
        .catch(() => null);
    },
    write({ key, previewImageUrl }) {
      const desktopKey = desktopDockPreviewCacheKey(key);
      const writeKey = JSON.stringify(desktopKey);
      if (pendingWriteKeys.has(writeKey)) {
        return;
      }
      pendingWriteKeys.add(writeKey);
      void api
        .write({
          dataUrl: previewImageUrl,
          key: desktopKey
        })
        .catch(() => {})
        .finally(() => {
          pendingWriteKeys.delete(writeKey);
        });
    }
  };
}

function desktopDockPreviewCacheKey(key: WorkbenchDockPreviewCacheKey) {
  return {
    instanceId: key.instanceId,
    instanceKey: key.instanceKey ?? null,
    nodeId: key.nodeId,
    revision: key.revision ?? null,
    typeId: key.typeId,
    workspaceId: key.workspaceId
  };
}
