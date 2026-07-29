import {
  EyeIcon,
  LaunchIcon,
  LocateFolderIcon,
  NewWorkspaceLinedIcon
} from "@tutti-os/ui-system";
import { createElement, type ReactElement } from "react";
import {
  resolveRevealInFolderLabel,
  type WorkspaceFileManagerContextMenuItem,
  type WorkspaceFileManagerI18nRuntime,
  type WorkspaceFileOpenWithApplication
} from "@tutti-os/workspace-file-manager";

export function buildReferenceSourcePickerContextMenuItems(input: {
  fileManagerCopy: WorkspaceFileManagerI18nRuntime;
  hostOs: NodeJS.Platform;
  isBusy: boolean;
  openWithApplications: WorkspaceFileOpenWithApplication[];
  openWithLoading: boolean;
  resolveOpenWithApplicationIcon?: (
    application: WorkspaceFileOpenWithApplication
  ) => ReactElement | null;
  showCreateDirectoryAction: boolean;
  showOpenAction: boolean;
  showOpenWithAction: boolean;
  showRevealInFolderAction: boolean;
  onCreateDirectory: () => void;
  onOpen: () => Promise<void>;
  onOpenWithApplication: (applicationPath: string) => Promise<void>;
  onOpenWithOtherApplication: () => Promise<void>;
  onRevealInFolder: () => Promise<void>;
}): WorkspaceFileManagerContextMenuItem[] {
  const {
    fileManagerCopy,
    hostOs,
    isBusy,
    openWithApplications,
    openWithLoading,
    resolveOpenWithApplicationIcon,
    showCreateDirectoryAction,
    showOpenAction,
    showOpenWithAction,
    showRevealInFolderAction,
    onCreateDirectory,
    onOpen,
    onOpenWithApplication,
    onOpenWithOtherApplication,
    onRevealInFolder
  } = input;
  const items: WorkspaceFileManagerContextMenuItem[] = [];

  if (showOpenAction) {
    items.push({
      type: "item",
      id: "open",
      disabled: isBusy,
      icon: createElement(EyeIcon, { className: "size-4" }),
      label: fileManagerCopy.t("openLabel"),
      onSelect: onOpen
    });
  }

  if (showOpenWithAction) {
    items.push({
      type: "submenu",
      id: "open-with",
      disabled: isBusy,
      icon: createElement(LaunchIcon, { className: "size-4" }),
      label: fileManagerCopy.t("openWithLabel"),
      loading: openWithLoading,
      loadingLabel: fileManagerCopy.t("openWithLoadingLabel"),
      children: openWithLoading
        ? []
        : buildOpenWithChildren({
            fileManagerCopy,
            isBusy,
            openWithApplications,
            resolveOpenWithApplicationIcon,
            onOpenWithApplication,
            onOpenWithOtherApplication
          })
    });
  }

  if (showCreateDirectoryAction) {
    if (items.length > 0) {
      items.push({ type: "separator", id: "separator-create" });
    }
    items.push({
      type: "item",
      id: "create-directory",
      disabled: isBusy,
      icon: createElement(NewWorkspaceLinedIcon, { className: "size-4" }),
      label: fileManagerCopy.t("createDirectoryLabel"),
      onSelect: onCreateDirectory
    });
  }

  if (showRevealInFolderAction) {
    if (items.length > 0) {
      items.push({ type: "separator", id: "separator-reveal" });
    }
    items.push({
      type: "item",
      id: "reveal",
      disabled: isBusy,
      icon: createElement(LocateFolderIcon, { className: "size-4" }),
      label: resolveRevealInFolderLabel(fileManagerCopy, hostOs),
      onSelect: onRevealInFolder
    });
  }

  return items;
}

function buildOpenWithChildren(input: {
  fileManagerCopy: WorkspaceFileManagerI18nRuntime;
  isBusy: boolean;
  openWithApplications: WorkspaceFileOpenWithApplication[];
  resolveOpenWithApplicationIcon?: (
    application: WorkspaceFileOpenWithApplication
  ) => ReactElement | null;
  onOpenWithApplication: (applicationPath: string) => Promise<void>;
  onOpenWithOtherApplication: () => Promise<void>;
}): WorkspaceFileManagerContextMenuItem[] {
  const {
    fileManagerCopy,
    isBusy,
    openWithApplications,
    resolveOpenWithApplicationIcon,
    onOpenWithApplication,
    onOpenWithOtherApplication
  } = input;
  const children: WorkspaceFileManagerContextMenuItem[] = [];

  for (const application of openWithApplications) {
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
      onSelect: () => onOpenWithApplication(application.applicationPath)
    });
  }

  children.push({
    type: "item",
    id: "open-with-other",
    disabled: isBusy,
    icon: createElement(LaunchIcon, { className: "size-4" }),
    label: fileManagerCopy.t("openWithOtherLabel"),
    onSelect: onOpenWithOtherApplication
  });

  return children;
}
