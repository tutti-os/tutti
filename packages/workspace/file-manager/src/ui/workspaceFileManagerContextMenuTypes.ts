import type { ReactElement } from "react";
import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";

/**
 * Right-click target classification. Hosts resolve menus for each kind via
 * `resolveContextMenu`.
 */
export type WorkspaceFileManagerContextMenuTarget =
  | {
      kind: "blank";
      directoryPath: string;
    }
  | {
      kind: "directory";
      directoryPath: string;
      entry: WorkspaceFileEntry;
    }
  | {
      kind: "file";
      directoryPath: string;
      entry: WorkspaceFileEntry;
    };

export interface WorkspaceFileManagerContextMenuRequest {
  currentDirectoryPath: string;
  isBusy: boolean;
  isExternalLocation: boolean;
  isRecentLocation: boolean;
  isSearchMode: boolean;
  selectedLocationId: string | null;
  target: WorkspaceFileManagerContextMenuTarget;
}

export type WorkspaceFileManagerContextMenuItem =
  | WorkspaceFileManagerContextMenuActionItem
  | WorkspaceFileManagerContextMenuSeparatorItem
  | WorkspaceFileManagerContextMenuSubmenuItem;

export interface WorkspaceFileManagerContextMenuActionItem {
  type: "item";
  id: string;
  label: string;
  icon?: ReactElement | null;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void | Promise<void>;
}

export interface WorkspaceFileManagerContextMenuSeparatorItem {
  type: "separator";
  id: string;
}

export interface WorkspaceFileManagerContextMenuSubmenuItem {
  type: "submenu";
  id: string;
  label: string;
  icon?: ReactElement | null;
  disabled?: boolean;
  /**
   * Host-driven loading indicator for controlled `children` (for example while
   * open-with applications are being fetched outside `loadChildren`).
   */
  loading?: boolean;
  loadingLabel?: string;
  children?: readonly WorkspaceFileManagerContextMenuItem[];
  loadChildren?: () => Promise<readonly WorkspaceFileManagerContextMenuItem[]>;
}

export type ResolveWorkspaceFileManagerContextMenu = (
  request: WorkspaceFileManagerContextMenuRequest
) =>
  | readonly WorkspaceFileManagerContextMenuItem[]
  | Promise<readonly WorkspaceFileManagerContextMenuItem[]>;

export function resolveWorkspaceFileManagerContextMenuTarget(input: {
  currentDirectoryPath: string;
  entry: WorkspaceFileEntry | null;
}): WorkspaceFileManagerContextMenuTarget {
  if (!input.entry) {
    return {
      kind: "blank",
      directoryPath: input.currentDirectoryPath
    };
  }
  if (input.entry.kind === "directory") {
    return {
      kind: "directory",
      directoryPath: input.currentDirectoryPath,
      entry: input.entry
    };
  }
  return {
    kind: "file",
    directoryPath: input.currentDirectoryPath,
    entry: input.entry
  };
}
