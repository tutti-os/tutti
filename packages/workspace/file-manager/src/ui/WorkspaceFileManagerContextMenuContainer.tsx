import type { ReactElement, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceFileManagerSession } from "../services/workspaceFileManagerService.interface.ts";
import {
  resolveRevealInFolderLabel,
  type WorkspaceFileManagerI18nRuntime
} from "../i18n/workspaceFileManagerI18n.ts";
import type { WorkspaceFileOpenWithApplication } from "../services/workspaceFileManagerTypes.ts";
import { isWorkspaceFileBrowserOpenable } from "../services/internal/model/openWithPolicy.ts";
import { WorkspaceFileManagerContextMenu } from "./WorkspaceFileManagerContextMenu.tsx";
import { useWorkspaceFileManagerContextMenuView } from "./useWorkspaceFileManagerService.ts";

export function WorkspaceFileManagerContextMenuContainer({
  hostOs,
  i18n,
  onCopyEntry,
  onCopyPath,
  openInAppBrowserIcon,
  resolveOpenWithApplicationIcon,
  session,
  showInternalOpenWithActions
}: {
  hostOs: NodeJS.Platform;
  i18n: WorkspaceFileManagerI18nRuntime;
  onCopyEntry?: () => Promise<void> | void;
  onCopyPath?: (path: string) => Promise<void> | void;
  openInAppBrowserIcon?: ReactElement;
  resolveOpenWithApplicationIcon?: (
    application: WorkspaceFileOpenWithApplication
  ) => ReactElement | null;
  session: WorkspaceFileManagerSession;
  showInternalOpenWithActions: boolean;
}): ReactElement | null {
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const { view } = useWorkspaceFileManagerContextMenuView(session);
  const [openWithApplications, setOpenWithApplications] = useState<
    WorkspaceFileOpenWithApplication[]
  >([]);
  const [openWithLoading, setOpenWithLoading] = useState(false);

  useEffect(() => {
    const entry = view.contextMenu?.entry;
    if (!entry || !view.showOpenWithAction) {
      setOpenWithApplications([]);
      setOpenWithLoading(false);
      return;
    }

    const cachedApplications = session.getCachedOpenWithApplications(entry);
    if (cachedApplications) {
      setOpenWithApplications(cachedApplications);
      setOpenWithLoading(false);
      return;
    }

    let cancelled = false;
    setOpenWithApplications([]);
    setOpenWithLoading(true);
    void session
      .listOpenWithApplications(entry)
      .then((applications) => {
        if (cancelled) {
          return;
        }
        setOpenWithApplications(applications);
        setOpenWithLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setOpenWithApplications([]);
        setOpenWithLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, view.contextMenu?.entry?.path, view.showOpenWithAction]);

  useCloseContextMenuOnOutsideInteraction({
    contextMenuRef,
    isOpen: view.contextMenu !== null,
    session
  });

  return (
    <WorkspaceFileManagerContextMenu
      busy={view.isBusy || view.isLoading || view.isMutating}
      copy={i18n}
      contextMenu={view.contextMenu}
      contextMenuRef={contextMenuRef}
      showCopyAction={view.showCopyAction}
      showCopyPathAction={true}
      showCreateDirectoryAction={
        view.contextMenu?.entry === null && view.showCreateDirectoryAction
      }
      showCreateFileAction={
        view.contextMenu?.entry === null && view.showCreateFileAction
      }
      showDeleteAction={view.showDeleteAction}
      showImportAction={view.showImportAction}
      showExportAction={view.showExportAction}
      showOpenInAppBrowserAction={
        showInternalOpenWithActions &&
        view.showOpenInAppBrowserAction &&
        !!view.contextMenu?.entry &&
        isWorkspaceFileBrowserOpenable(view.contextMenu.entry)
      }
      showOpenInDefaultBrowserAction={
        view.showOpenInDefaultBrowserAction &&
        !!view.contextMenu?.entry &&
        isWorkspaceFileBrowserOpenable(view.contextMenu.entry)
      }
      showOpenInFileViewerAction={
        showInternalOpenWithActions && view.showOpenInFileViewerAction
      }
      showOpenAction={true}
      showOpenWithAction={view.showOpenWithAction}
      showOpenWithOtherAction={view.showOpenWithOtherAction}
      showRevealInFolderAction={view.showRevealInFolderAction}
      showRenameAction={view.showRenameAction}
      revealInFolderLabel={resolveRevealInFolderLabel(i18n, hostOs)}
      openInAppBrowserIcon={openInAppBrowserIcon}
      openWithApplications={openWithApplications}
      openWithLoading={openWithLoading}
      resolveOpenWithApplicationIcon={resolveOpenWithApplicationIcon}
      onClose={() => {
        session.closeContextMenu();
      }}
      onCreateDirectory={() => {
        session.openCreateDirectoryDialog();
      }}
      onCreateFile={() => {
        session.openCreateFileDialog();
      }}
      onCopy={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        session.closeContextMenu();
        await session.copyToClipboard(entry);
        if (onCopyEntry) {
          await onCopyEntry();
        }
      }}
      onCopyPath={async () => {
        const path = view.contextMenu?.entry?.path;
        if (!path) {
          return;
        }
        session.closeContextMenu();
        if (onCopyPath) {
          await onCopyPath(path);
          return;
        }
        await navigator.clipboard.writeText(path);
      }}
      onDelete={() => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        session.openDeleteDialog(entry);
      }}
      onRename={() => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        session.startInlineRename(entry);
      }}
      onExport={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.exportEntry(entry);
      }}
      onOpen={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.openEntry(entry);
      }}
      onOpenInAppBrowser={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.openFileInAppBrowser(entry);
      }}
      onOpenInDefaultBrowser={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.openFileInDefaultBrowser(entry);
      }}
      onOpenInFileViewer={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.openFileInFileViewer(entry);
      }}
      onOpenWithApplication={async (applicationPath) => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.openFileWithApplication(entry, applicationPath);
      }}
      onOpenWithOtherApplication={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.openFileWithOtherApplication(entry);
      }}
      onRevealInFolder={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.revealEntry(entry);
      }}
      onImport={async () => {
        session.closeContextMenu();
        await session.importFiles(
          view.contextMenu?.entry?.kind === "directory"
            ? view.contextMenu.entry.path
            : view.currentDirectoryPath
        );
      }}
    />
  );
}

function useCloseContextMenuOnOutsideInteraction(input: {
  contextMenuRef: RefObject<HTMLDivElement | null>;
  isOpen: boolean;
  session: WorkspaceFileManagerSession;
}): void {
  const { contextMenuRef, isOpen, session } = input;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && contextMenuRef.current?.contains(target)) {
        return;
      }
      if (
        target instanceof Element &&
        target.closest("[data-workspace-file-manager-submenu]")
      ) {
        return;
      }
      session.closeContextMenu();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        session.closeContextMenu();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenuRef, isOpen, session]);
}
