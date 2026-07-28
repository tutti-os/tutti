import type { WorkbenchNode } from "../core/types.ts";

export interface WorkbenchNodePreviewImages {
  dockPreviewImageUrl: string | null;
  genieImageUrl: string | null;
}

export type WorkbenchNodePreviewImagesCapture<TData = unknown> = (
  node: WorkbenchNode<TData>
) =>
  | Promise<WorkbenchNodePreviewImages | null>
  | WorkbenchNodePreviewImages
  | null;

export type WorkbenchNodePreviewImageCapture<TData = unknown> = (
  node: WorkbenchNode<TData>
) => Promise<string | null> | string | null;
