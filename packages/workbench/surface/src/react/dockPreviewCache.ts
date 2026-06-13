import type { WorkbenchNode } from "../core/types.ts";

export interface WorkbenchDockPreviewCacheKey {
  instanceId: string;
  instanceKey?: string | null;
  nodeId: string;
  revision?: string | null;
  typeId: string;
  workspaceId: string;
}

export interface WorkbenchDockPreviewCache {
  read(key: WorkbenchDockPreviewCacheKey): Promise<string | null>;
  write(input: {
    key: WorkbenchDockPreviewCacheKey;
    previewImageUrl: string;
  }): void;
}

export type WorkbenchDockPreviewCacheKeyResolver<TData = unknown> = (
  node: WorkbenchNode<TData>
) => WorkbenchDockPreviewCacheKey | null;
