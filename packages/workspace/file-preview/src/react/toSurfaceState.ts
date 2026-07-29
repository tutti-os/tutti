/**
 * Projects controller state into surface state with host-provided copy.
 *
 * Ownership rules: packages/workspace/file-preview/CONTRACT.md
 */

import type {
  WorkspaceFilePreviewControllerState,
  WorkspaceFilePreviewUnsupportedReason
} from "../core/workspaceFilePreviewController.ts";
import type { WorkspaceFilePreviewReadonlyReason } from "../core/workspaceFilePreview.ts";
import type { WorkspaceFilePreviewKind } from "../core/workspaceFilePreviewKinds.ts";
import type { WorkspaceFilePreviewSurfaceState } from "./workspaceFilePreviewSurface.tsx";

export interface WorkspaceFilePreviewSurfaceCopy {
  errorMessage: (error: unknown) => string;
  readonlyMessage: (
    reason: WorkspaceFilePreviewReadonlyReason,
    maxSizeBytes?: number
  ) => string;
  unsupportedMessage: (
    reason: WorkspaceFilePreviewUnsupportedReason,
    previewKind?: WorkspaceFilePreviewKind
  ) => string;
}

/**
 * Shared projection from machine-readable controller state to the React
 * surface state. Controllers remain the source of truth; hosts inject copy.
 */
export function toSurfaceState<TEntry>(
  state: WorkspaceFilePreviewControllerState<TEntry>,
  copy: WorkspaceFilePreviewSurfaceCopy
): WorkspaceFilePreviewSurfaceState<TEntry> {
  switch (state.status) {
    case "empty":
      return { status: "empty" };
    case "directory":
      return { entry: state.entry, status: "directory" };
    case "loading":
      return {
        entry: state.entry,
        previewKind: state.previewKind,
        status: "loading"
      };
    case "text":
      return {
        content: state.content,
        entry: state.entry,
        previewKind: state.previewKind,
        status: "text"
      };
    case "image":
      return {
        entry: state.entry,
        objectUrl: state.objectUrl,
        previewKind: "image",
        status: "image"
      };
    case "video":
      return {
        entry: state.entry,
        objectUrl: state.objectUrl,
        previewKind: "video",
        status: "video"
      };
    case "bytes":
      return {
        bytes: state.bytes,
        contentType: state.contentType,
        entry: state.entry,
        previewKind: state.previewKind,
        status: "bytes"
      };
    case "readonly":
      return {
        entry: state.entry,
        message: copy.readonlyMessage(state.reason, state.maxSizeBytes),
        previewKind: state.previewKind,
        status: "readonly"
      };
    case "unsupported":
      return {
        entry: state.entry,
        message: copy.unsupportedMessage(state.reason, state.previewKind),
        previewKind: state.previewKind,
        status: "unsupported"
      };
    case "error":
      return {
        entry: state.entry,
        message: copy.errorMessage(state.error),
        previewKind: state.previewKind,
        status: "error"
      };
  }
}
