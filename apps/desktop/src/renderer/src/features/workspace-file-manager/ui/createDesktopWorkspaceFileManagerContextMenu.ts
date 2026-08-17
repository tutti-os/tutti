import {
  CopyIcon,
  DeleteIcon,
  EditIcon,
  EyeIcon,
  FileLinedIcon,
  LaunchIcon,
  LocateFolderIcon,
  NewWorkspaceLinedIcon,
  WebIcon
} from "@tutti-os/ui-system";
import { createElement, type ReactElement } from "react";
import {
  formatWorkspaceFilePathForDisplay,
  isWorkspaceFileBrowserOpenable,
  resolveRevealInFolderLabel,
  type WorkspaceFileEntry,
  type WorkspaceFileManagerI18nRuntime,
  type WorkspaceFileManagerSession,
  type WorkspaceFileOpenWithApplication
} from "@tutti-os/workspace-file-manager/services";
import type {
  ResolveWorkspaceFileManagerContextMenu,
  WorkspaceFileManagerContextMenuItem
} from "@tutti-os/workspace-file-manager";
import { resolveWorkspaceFilePreviewTarget } from "@tutti-os/workspace-file-preview";
import type { AppI18nRuntime } from "@renderer/i18n/appRuntime.ts";

export function createDesktopWorkspaceFileManagerContextMenu(input: {
  appI18n: AppI18nRuntime;
  hostOs: NodeJS.Platform;
  i18n: WorkspaceFileManagerI18nRuntime;
  onCopyEntry?: () => Promise<void> | void;
  onCopyPath?: (path: string) => Promise<void> | void;
  openInAppBrowserIcon?: ReactElement;
  resolveOpenWithApplicationIcon?: (
    application: WorkspaceFileOpenWithApplication
  ) => ReactElement | null;
  session: WorkspaceFileManagerSession;
  showInternalOpenWithActions?: boolean;
}): ResolveWorkspaceFileManagerContextMenu {
  const {
    appI18n,
    hostOs,
    i18n,
    onCopyEntry,
    onCopyPath,
    openInAppBrowserIcon,
    resolveOpenWithApplicationIcon,
    session,
    showInternalOpenWithActions = true
  } = input;

  return (request) => {
    const {
      target,
      isBusy,
      isExternalLocation,
      isRecentLocation,
      isSearchMode
    } = request;
    const canMutate = !isExternalLocation && !isRecentLocation && !isSearchMode;
    const capabilities = session.store.capabilities;
    const items: WorkspaceFileManagerContextMenuItem[] = [];

    if (target.kind === "blank") {
      if (canMutate && capabilities.canCreateFile) {
        items.push({
          type: "item",
          id: "create-file",
          disabled: isBusy,
          icon: createElement(FileLinedIcon, { className: "size-4" }),
          label: appI18n.t("workspaceFileManager.createFileLabel"),
          onSelect: () => {
            session.openCreateFileDialog();
          }
        });
      }
      if (canMutate && capabilities.canCreateDirectory) {
        items.push({
          type: "item",
          id: "create-directory",
          disabled: isBusy,
          icon: createElement(NewWorkspaceLinedIcon, { className: "size-4" }),
          label: appI18n.t("workspaceFileManager.createDirectoryLabel"),
          onSelect: () => {
            session.openCreateDirectoryDialog();
          }
        });
      }
      return items;
    }

    const entry = target.entry;
    items.push({
      type: "item",
      id: "open",
      disabled: isBusy,
      icon: createElement(EyeIcon, { className: "size-4" }),
      label: appI18n.t("workspaceFileManager.openLabel"),
      onSelect: async () => {
        await session.openEntry(entry);
      }
    });

    if (target.kind === "file" && capabilities.canOpenWith) {
      items.push({
        type: "submenu",
        id: "open-with",
        disabled: isBusy,
        icon: createElement(LaunchIcon, { className: "size-4" }),
        label: appI18n.t("workspaceFileManager.openWithLabel"),
        loadingLabel: appI18n.t("workspaceFileManager.openWithLoadingLabel"),
        loadChildren: async () =>
          buildOpenWithChildren({
            appI18n,
            entry,
            isBusy,
            openInAppBrowserIcon,
            resolveOpenWithApplicationIcon,
            session,
            showInternalOpenWithActions
          })
      });
    }

    if (target.kind === "directory") {
      if (canMutate && capabilities.canCreateFile) {
        items.push({
          type: "item",
          id: "create-file",
          disabled: isBusy,
          icon: createElement(FileLinedIcon, { className: "size-4" }),
          label: appI18n.t("workspaceFileManager.createFileLabel"),
          onSelect: () => {
            session.openCreateFileDialog();
          }
        });
      }
      if (canMutate && capabilities.canCreateDirectory) {
        items.push({
          type: "item",
          id: "create-directory",
          disabled: isBusy,
          icon: createElement(NewWorkspaceLinedIcon, { className: "size-4" }),
          label: appI18n.t("workspaceFileManager.createDirectoryLabel"),
          onSelect: () => {
            session.openCreateDirectoryDialog();
          }
        });
      }
    }

    const editItems: WorkspaceFileManagerContextMenuItem[] = [];
    if (canMutate && capabilities.canRename) {
      editItems.push({
        type: "item",
        id: "rename",
        disabled: isBusy,
        icon: createElement(EditIcon, { className: "size-4" }),
        label: appI18n.t("workspaceFileManager.renameLabel"),
        onSelect: () => {
          session.startInlineRename(entry);
        }
      });
    }
    if (capabilities.canCopy) {
      editItems.push({
        type: "item",
        id: "copy",
        disabled: isBusy,
        icon: createElement(CopyIcon, { className: "size-4" }),
        label: appI18n.t("workspaceFileManager.copyLabel"),
        onSelect: async () => {
          if (await session.copyToClipboard(entry)) {
            await onCopyEntry?.();
          }
        }
      });
    }
    editItems.push({
      type: "item",
      id: "copy-path",
      disabled: isBusy,
      icon: createElement(CopyIcon, { className: "size-4" }),
      label: appI18n.t("workspaceFileManager.copyPathLabel"),
      onSelect: async () => {
        const displayPath = formatWorkspaceFilePathForDisplay(
          entry.path,
          hostOs
        );
        if (onCopyPath) {
          await onCopyPath(displayPath);
          return;
        }
        await navigator.clipboard.writeText(displayPath);
      }
    });
    if (capabilities.canRevealInFolder && !isExternalLocation) {
      editItems.push({
        type: "item",
        id: "reveal",
        disabled: isBusy,
        icon: createElement(LocateFolderIcon, { className: "size-4" }),
        label: resolveRevealInFolderLabel(i18n, hostOs),
        onSelect: async () => {
          await session.revealEntry(entry);
        }
      });
    }

    if (editItems.length > 0) {
      if (items.length > 0) {
        items.push({ type: "separator", id: "separator-edit" });
      }
      items.push(...editItems);
    }

    if (canMutate && capabilities.canDelete) {
      items.push({ type: "separator", id: "separator-danger" });
      items.push({
        type: "item",
        id: "delete",
        danger: true,
        disabled: isBusy,
        icon: createElement(DeleteIcon, { className: "size-4" }),
        label: appI18n.t("workspaceFileManager.deleteLabel"),
        onSelect: () => {
          session.openDeleteDialog(entry);
        }
      });
    }

    return items;
  };
}

async function buildOpenWithChildren(input: {
  appI18n: AppI18nRuntime;
  entry: WorkspaceFileEntry;
  isBusy: boolean;
  openInAppBrowserIcon?: ReactElement;
  resolveOpenWithApplicationIcon?: (
    application: WorkspaceFileOpenWithApplication
  ) => ReactElement | null;
  session: WorkspaceFileManagerSession;
  showInternalOpenWithActions: boolean;
}): Promise<WorkspaceFileManagerContextMenuItem[]> {
  const {
    appI18n,
    entry,
    isBusy,
    openInAppBrowserIcon,
    resolveOpenWithApplicationIcon,
    session,
    showInternalOpenWithActions
  } = input;
  const capabilities = session.store.capabilities;
  const browserOpenable = isWorkspaceFileBrowserOpenable(entry);
  const children: WorkspaceFileManagerContextMenuItem[] = [];

  if (
    showInternalOpenWithActions &&
    resolveWorkspaceFilePreviewTarget(entry) !== null
  ) {
    children.push({
      type: "item",
      id: "open-in-file-viewer",
      disabled: isBusy,
      icon: createElement(EyeIcon, { className: "size-4" }),
      label: appI18n.t("workspaceFileManager.openInFileViewerLabel"),
      onSelect: async () => {
        await session.openFileInFileViewer(entry);
      }
    });
  }
  if (
    showInternalOpenWithActions &&
    capabilities.canOpenInAppBrowser &&
    browserOpenable
  ) {
    children.push({
      type: "item",
      id: "open-in-app-browser",
      disabled: isBusy,
      icon:
        openInAppBrowserIcon ?? createElement(WebIcon, { className: "size-4" }),
      label: appI18n.t("workspaceFileManager.openInAppBrowserLabel"),
      onSelect: async () => {
        await session.openFileInAppBrowser(entry);
      }
    });
  }

  const applications = await session.listOpenWithApplications(entry);
  if (
    (capabilities.canOpenInDefaultBrowser && browserOpenable) ||
    capabilities.canPickOtherOpenWithApplication ||
    applications.length > 0
  ) {
    if (children.length > 0) {
      children.push({ type: "separator", id: "open-with-apps-separator" });
    }
  }

  for (const application of applications) {
    const resolvedIcon = resolveOpenWithApplicationIcon?.(application);
    children.push({
      type: "item",
      id: `open-with-app:${application.applicationPath}`,
      disabled: isBusy,
      icon:
        resolvedIcon ??
        (application.iconDataUrl
          ? createElement("img", {
              alt: "",
              className: "size-4 rounded-[4px] object-contain",
              src: application.iconDataUrl
            })
          : createElement(EyeIcon, { className: "size-4" })),
      label: application.name,
      onSelect: async () => {
        await session.openFileWithApplication(
          entry,
          application.applicationPath
        );
      }
    });
  }

  if (capabilities.canOpenInDefaultBrowser && browserOpenable) {
    children.push({
      type: "item",
      id: "open-in-default-browser",
      disabled: isBusy,
      icon: createElement(WebIcon, { className: "size-4" }),
      label: appI18n.t("workspaceFileManager.openInDefaultBrowserLabel"),
      onSelect: async () => {
        await session.openFileInDefaultBrowser(entry);
      }
    });
  }
  if (capabilities.canPickOtherOpenWithApplication) {
    children.push({
      type: "item",
      id: "open-with-other",
      disabled: isBusy,
      icon: createElement(LaunchIcon, { className: "size-4" }),
      label: appI18n.t("workspaceFileManager.openWithOtherLabel"),
      onSelect: async () => {
        await session.openFileWithOtherApplication(entry);
      }
    });
  }

  return children;
}
