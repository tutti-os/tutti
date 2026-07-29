import type { ReactElement } from "react";

import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";

export type WorkspaceFileManagerPreviewActionId =
  | "copy"
  | "download"
  | "open"
  | "share";

export const workspaceFileManagerPreviewActionOrder = [
  "copy",
  "open",
  "download",
  "share"
] as const satisfies readonly WorkspaceFileManagerPreviewActionId[];

/**
 * Declares which actions the preview panel renders in its bottom action row.
 *
 * Copy and open are backed by session commands the package already owns, so
 * hosts only opt in with a boolean. Download and share have no package-side
 * implementation, so passing a handler is what enables them — the same
 * "capability exists when the method exists" convention the host contract uses.
 */
export interface WorkspaceFileManagerPreviewActionsConfig {
  /** Enables copy. Still requires `capabilities.canCopy`. */
  copy?: boolean;
  /** Enables open. */
  open?: boolean;
  onDownload?: (entry: WorkspaceFileEntry) => Promise<void> | void;
  onShare?: (entry: WorkspaceFileEntry) => Promise<void> | void;
  /** Overrides button order. Defaults to copy, open, download, share. */
  order?: readonly WorkspaceFileManagerPreviewActionId[];
}

/** Internal descriptor produced once the config is resolved against session state. */
export interface WorkspaceFileManagerPreviewAction {
  disabled: boolean;
  icon: ReactElement;
  id: WorkspaceFileManagerPreviewActionId;
  label: string;
  onSelect: () => void;
}
