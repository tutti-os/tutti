import {
  ArrowRightIcon,
  CopyIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  EyeIcon,
  FileLinedIcon,
  ImportLinedIcon as ImportIcon,
  LaunchIcon,
  LocateFolderIcon,
  MenuSurface,
  NewWorkspaceLinedIcon,
  ViewportMenuSurface,
  WebIcon,
  cn
} from "@tutti-os/ui-system";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject
} from "react";
import {
  CONTEXT_MENU_SUBMENU_GAP_PX,
  clampContextMenuPosition,
  estimateOpenWithSubmenuHeight
} from "./contextMenuPlacement.ts";
import type { WorkspaceFileManagerI18nRuntime } from "../i18n/workspaceFileManagerI18n.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileOpenWithApplication
} from "../services/workspaceFileManagerTypes.ts";

export interface WorkspaceFileManagerContextMenuProps {
  busy: boolean;
  copy: WorkspaceFileManagerI18nRuntime;
  contextMenu: {
    entry: WorkspaceFileEntry | null;
    x: number;
    y: number;
  } | null;
  contextMenuRef: RefObject<HTMLDivElement | null>;
  openInAppBrowserIcon?: ReactElement;
  positionMode?: "local" | "viewport";
  resolveOpenWithApplicationIcon?: (
    application: WorkspaceFileOpenWithApplication
  ) => ReactElement | null;
  showCopyAction: boolean;
  showCopyPathAction: boolean;
  showCreateAction: boolean;
  showDeleteAction: boolean;
  showImportAction: boolean;
  showExportAction: boolean;
  showOpenInAppBrowserAction: boolean;
  showOpenInDefaultBrowserAction: boolean;
  showOpenInFileViewerAction: boolean;
  showOpenWithAction: boolean;
  showOpenWithOtherAction: boolean;
  showRevealInFolderAction: boolean;
  showRenameAction: boolean;
  revealInFolderLabel: string;
  openWithApplications: readonly WorkspaceFileOpenWithApplication[];
  openWithLoading: boolean;
  onClose: () => void;
  onCreateDirectory: () => void;
  onCreateFile: () => void;
  onCopy: () => Promise<void>;
  onCopyPath: () => Promise<void>;
  onDelete: () => void;
  onExport: () => Promise<void>;
  onOpen: () => Promise<void>;
  onOpenInAppBrowser: () => Promise<void>;
  onOpenInDefaultBrowser: () => Promise<void>;
  onOpenInFileViewer: () => Promise<void>;
  onOpenWithApplication: (applicationPath: string) => Promise<void>;
  onOpenWithOtherApplication: () => Promise<void>;
  onImport: () => Promise<void>;
  onRevealInFolder: () => Promise<void>;
  onRename: () => void;
}

export function WorkspaceFileManagerContextMenu({
  busy,
  copy,
  contextMenu,
  contextMenuRef,
  openInAppBrowserIcon,
  positionMode = "local",
  showCopyAction,
  showCopyPathAction,
  showCreateAction,
  showDeleteAction,
  showImportAction,
  showExportAction,
  showOpenInAppBrowserAction,
  showOpenInDefaultBrowserAction,
  showOpenInFileViewerAction,
  showOpenWithAction,
  showOpenWithOtherAction,
  showRevealInFolderAction,
  showRenameAction,
  revealInFolderLabel,
  openWithApplications,
  openWithLoading,
  resolveOpenWithApplicationIcon,
  onClose,
  onCreateDirectory,
  onCreateFile,
  onCopy,
  onCopyPath,
  onDelete,
  onExport,
  onOpen,
  onOpenInAppBrowser,
  onOpenInDefaultBrowser,
  onOpenInFileViewer,
  onOpenWithApplication,
  onOpenWithOtherApplication,
  onImport,
  onRevealInFolder,
  onRename
}: WorkspaceFileManagerContextMenuProps): ReactElement | null {
  const [position, setPosition] = useState({
    x: contextMenu?.x ?? 0,
    y: contextMenu?.y ?? 0
  });

  useLayoutEffect(() => {
    if (!contextMenu) {
      return;
    }

    setPosition({ x: contextMenu.x, y: contextMenu.y });
  }, [contextMenu?.x, contextMenu?.y]);

  useLayoutEffect(() => {
    if (!contextMenu) {
      return;
    }

    const menu = contextMenuRef.current;
    if (!menu) {
      return;
    }

    const menuRect = menu.getBoundingClientRect();
    const boundary =
      positionMode === "local"
        ? menu.closest(
            "[data-workspace-file-menu-boundary], [data-workspace-file-manager]"
          )
        : null;
    if (positionMode === "local" && !boundary) {
      return;
    }
    const boundaryRect = boundary?.getBoundingClientRect();
    setPosition(
      clampContextMenuPosition({
        boundaryHeight: boundaryRect?.height ?? window.innerHeight,
        boundaryWidth: boundaryRect?.width ?? window.innerWidth,
        menuHeight: menuRect.height,
        menuWidth: menuRect.width,
        x: contextMenu.x,
        y: contextMenu.y
      })
    );
  }, [
    contextMenu,
    contextMenuRef,
    openWithApplications.length,
    openWithLoading,
    positionMode,
    showCopyAction,
    showCopyPathAction,
    showExportAction,
    showImportAction,
    showOpenInAppBrowserAction,
    showOpenInDefaultBrowserAction,
    showOpenInFileViewerAction,
    showOpenWithAction,
    showOpenWithOtherAction,
    showRevealInFolderAction,
    showRenameAction
  ]);

  if (!contextMenu) {
    return null;
  }

  const entry = contextMenu.entry;
  const isDirectory = entry?.kind === "directory";
  const editItems: ContextMenuActionItem[] = [];
  const transferItems: ContextMenuActionItem[] = [];
  const dangerItems: ContextMenuActionItem[] = [];
  const createItems: ContextMenuActionItem[] = [];

  if (entry) {
    if (showRenameAction) {
      editItems.push({
        action: onRename,
        disabled: busy,
        icon: <EditIcon className="size-4" />,
        key: "rename",
        label: copy.t("renameLabel")
      });
    }
    if (showCopyAction) {
      editItems.push({
        action: onCopy,
        disabled: busy,
        icon: <CopyIcon className="size-4" />,
        key: "copy",
        label: copy.t("copyLabel")
      });
    }
    if (showCopyPathAction) {
      editItems.push({
        action: onCopyPath,
        disabled: busy,
        icon: <CopyIcon className="size-4" />,
        key: "copy-path",
        label: copy.t("copyPathLabel")
      });
    }
    if (showRevealInFolderAction) {
      editItems.push({
        action: onRevealInFolder,
        disabled: busy,
        icon: <LocateFolderIcon className="size-4" />,
        key: "reveal-in-folder",
        label: revealInFolderLabel
      });
    }
    if (isDirectory && showImportAction) {
      transferItems.push({
        action: onImport,
        disabled: busy,
        icon: <ImportIcon className="size-4" />,
        key: "import",
        label: copy.t("importLabel")
      });
    }
    if (showExportAction) {
      transferItems.push({
        action: onExport,
        disabled: busy,
        icon: <DownloadIcon className="size-4" />,
        key: "export",
        label: copy.t("downloadLabel")
      });
    }
    if (showDeleteAction) {
      dangerItems.push({
        action: onDelete,
        disabled: busy,
        danger: true,
        icon: <DeleteIcon className="size-4" />,
        key: "delete",
        label: copy.t("deleteLabel")
      });
    }
  } else {
    if (showCreateAction) {
      createItems.push({
        action: onCreateFile,
        disabled: busy,
        icon: <NewWorkspaceLinedIcon className="size-4" />,
        key: "create-file",
        label: copy.t("createFileLabel")
      });
      createItems.push({
        action: onCreateDirectory,
        disabled: busy,
        icon: <FileLinedIcon className="size-4" />,
        key: "create-directory",
        label: copy.t("createDirectoryLabel")
      });
    }
    if (showImportAction) {
      transferItems.push({
        action: onImport,
        disabled: busy,
        icon: <ImportIcon className="size-4" />,
        key: "import",
        label: copy.t("importLabel")
      });
    }
  }
  const menuGroups: Array<{
    items: readonly ContextMenuActionItem[];
    key: string;
  }> = entry
    ? [
        { items: editItems, key: "edit" },
        { items: transferItems, key: "transfer" },
        { items: dangerItems, key: "danger" }
      ]
    : [
        { items: createItems, key: "create" },
        { items: transferItems, key: "transfer" }
      ];
  const visibleMenuGroups = menuGroups.filter(
    (group) => group.items.length > 0
  );

  return (
    <MenuSurface
      ref={contextMenuRef}
      className={cn(
        "w-[220px] overflow-visible p-1",
        positionMode === "viewport" ? "fixed" : "absolute"
      )}
      role="menu"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        zIndex: "calc(var(--workspace-file-manager-dialog-overlay-z-index) - 1)"
      }}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      {entry ? (
        <ContextMenuActionButton
          disabled={busy}
          icon={<EyeIcon className="size-4" />}
          label={copy.t("openLabel")}
          onClick={() => {
            onClose();
            void onOpen();
          }}
        />
      ) : null}
      {entry && showOpenWithAction ? (
        <OpenWithMenuItem
          applications={openWithApplications}
          busy={busy}
          copy={copy}
          isLoading={openWithLoading}
          openInAppBrowserIcon={openInAppBrowserIcon}
          resolveOpenWithApplicationIcon={resolveOpenWithApplicationIcon}
          showOpenInAppBrowser={showOpenInAppBrowserAction}
          showOpenInDefaultBrowser={showOpenInDefaultBrowserAction}
          showOpenInFileViewer={showOpenInFileViewerAction}
          showOpenWithOther={showOpenWithOtherAction}
          onClose={onClose}
          onOpenInAppBrowser={onOpenInAppBrowser}
          onOpenInDefaultBrowser={onOpenInDefaultBrowser}
          onOpenInFileViewer={onOpenInFileViewer}
          onOpenWithApplication={onOpenWithApplication}
          onOpenWithOtherApplication={onOpenWithOtherApplication}
        />
      ) : null}
      {visibleMenuGroups.map((group, groupIndex) => (
        <ContextMenuActionGroup
          key={group.key}
          items={group.items}
          showDivider={entry !== null || groupIndex > 0}
          onClose={onClose}
        />
      ))}
    </MenuSurface>
  );
}
interface ContextMenuActionItem {
  action: () => Promise<void> | void;
  disabled?: boolean;
  danger?: boolean;
  icon: ReactElement;
  key: string;
  label: string;
}

function ContextMenuActionGroup({
  items,
  onClose,
  showDivider
}: {
  items: readonly ContextMenuActionItem[];
  onClose: () => void;
  showDivider: boolean;
}): ReactElement {
  return (
    <>
      {showDivider ? <ContextMenuDivider /> : null}
      {items.map((item) => (
        <ContextMenuActionButton
          key={item.key}
          danger={item.danger}
          disabled={item.disabled}
          icon={item.icon}
          label={item.label}
          onClick={() => {
            onClose();
            void item.action();
          }}
        />
      ))}
    </>
  );
}

function ContextMenuActionButton({
  activateOnPointerDown = false,
  danger = false,
  disabled = false,
  icon,
  label,
  onClick
}: {
  activateOnPointerDown?: boolean;
  danger?: boolean;
  disabled?: boolean;
  icon: ReactElement;
  label: string;
  onClick: () => void;
}): ReactElement {
  const pointerActivatedRef = useRef(false);
  const pointerActivationResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pointerActivationResetTimerRef.current !== null) {
        window.clearTimeout(pointerActivationResetTimerRef.current);
      }
    };
  }, []);

  return (
    <button
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-[13px] transition-colors disabled:cursor-default disabled:opacity-50",
        danger
          ? "text-[var(--state-danger)] hover:bg-[var(--on-danger)]"
          : "text-[var(--text-primary)] hover:bg-transparency-block"
      )}
      disabled={disabled}
      role="menuitem"
      type="button"
      onClick={() => {
        if (pointerActivatedRef.current) {
          pointerActivatedRef.current = false;
          if (pointerActivationResetTimerRef.current !== null) {
            window.clearTimeout(pointerActivationResetTimerRef.current);
            pointerActivationResetTimerRef.current = null;
          }
          return;
        }
        onClick();
      }}
      onPointerDown={(event) => {
        if (!activateOnPointerDown || disabled || event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        pointerActivatedRef.current = true;
        if (pointerActivationResetTimerRef.current !== null) {
          window.clearTimeout(pointerActivationResetTimerRef.current);
        }
        pointerActivationResetTimerRef.current = window.setTimeout(() => {
          pointerActivatedRef.current = false;
          pointerActivationResetTimerRef.current = null;
        }, 750);
        onClick();
      }}
    >
      <span
        className={cn(
          "grid size-4 flex-none place-items-center",
          danger ? "text-[var(--state-danger)]" : "text-[var(--text-secondary)]"
        )}
      >
        {icon}
      </span>
      {label}
    </button>
  );
}

function ContextMenuDivider(): ReactElement {
  return (
    <div className="mx-2 my-0.5 h-px bg-[var(--border-1)]" role="separator" />
  );
}

function OpenWithMenuItem({
  applications,
  busy,
  copy,
  isLoading,
  openInAppBrowserIcon,
  resolveOpenWithApplicationIcon,
  showOpenInAppBrowser,
  showOpenInDefaultBrowser,
  showOpenInFileViewer,
  showOpenWithOther,
  onClose,
  onOpenInAppBrowser,
  onOpenInDefaultBrowser,
  onOpenInFileViewer,
  onOpenWithApplication,
  onOpenWithOtherApplication
}: {
  applications: readonly WorkspaceFileOpenWithApplication[];
  busy: boolean;
  copy: WorkspaceFileManagerI18nRuntime;
  isLoading: boolean;
  openInAppBrowserIcon?: ReactElement;
  resolveOpenWithApplicationIcon?: (
    application: WorkspaceFileOpenWithApplication
  ) => ReactElement | null;
  showOpenInAppBrowser: boolean;
  showOpenInDefaultBrowser: boolean;
  showOpenInFileViewer: boolean;
  showOpenWithOther: boolean;
  onClose: () => void;
  onOpenInAppBrowser: () => Promise<void>;
  onOpenInDefaultBrowser: () => Promise<void>;
  onOpenInFileViewer: () => Promise<void>;
  onOpenWithApplication: (applicationPath: string) => Promise<void>;
  onOpenWithOtherApplication: () => Promise<void>;
}): ReactElement {
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [submenuPosition, setSubmenuPosition] = useState({ left: 0, top: 0 });
  const closeTimerRef = useRef<number | null>(null);
  const showExternalSection =
    showOpenInDefaultBrowser ||
    showOpenWithOther ||
    isLoading ||
    applications.length > 0;
  const estimatedSubmenuHeight = estimateOpenWithSubmenuHeight({
    applicationCount: applications.length,
    isLoading,
    showExternalSection,
    showOpenInAppBrowser,
    showOpenInDefaultBrowser,
    showOpenInFileViewer,
    showOpenWithOther
  });

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 120);
  }, [cancelClose]);

  const openSubmenu = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  useEffect(() => {
    return () => {
      cancelClose();
    };
  }, [cancelClose]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const maxHeight = Math.min(
      estimatedSubmenuHeight,
      480,
      Math.max(0, window.innerHeight - 24)
    );
    setSubmenuPosition({
      left: rect.right + CONTEXT_MENU_SUBMENU_GAP_PX,
      top: Math.max(12, Math.min(rect.top, window.innerHeight - maxHeight - 12))
    });
  }, [open, estimatedSubmenuHeight]);

  return (
    <div
      ref={triggerRef}
      className="relative"
      onPointerEnter={openSubmenu}
      onPointerLeave={scheduleClose}
    >
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-[13px] text-[var(--text-primary)] transition-colors hover:bg-transparency-block disabled:cursor-default disabled:opacity-50",
          open && "bg-transparency-block"
        )}
        disabled={busy}
        role="menuitem"
        type="button"
        onClick={() => {
          setOpen((current) => {
            const next = !current;
            if (next) {
              cancelClose();
            }
            return next;
          });
        }}
      >
        <span className="grid size-4 flex-none place-items-center text-[var(--text-secondary)]">
          <LaunchIcon className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {copy.t("openWithLabel")}
        </span>
        <span
          aria-hidden="true"
          className="grid size-4 flex-none place-items-center text-[var(--text-tertiary)]"
        >
          <ArrowRightIcon className="size-4" />
        </span>
      </button>
      <ViewportMenuSurface
        data-workspace-file-manager-submenu=""
        open={open}
        className="w-[220px] max-h-[min(480px,calc(100vh-24px))] overflow-y-auto p-1"
        dismissOnEscape={false}
        dismissOnPointerDownOutside={false}
        dismissOnScroll={false}
        placement={{
          type: "absolute",
          left: submenuPosition.left,
          top: submenuPosition.top,
          boundaryPoint: { x: -1, y: -1 },
          constrainToBoundary: false
        }}
        role="menu"
        style={{ zIndex: "calc(var(--z-panel-popover) + 200)" }}
        onPointerEnter={openSubmenu}
        onPointerLeave={scheduleClose}
      >
        {showOpenInFileViewer ? (
          <ContextMenuActionButton
            activateOnPointerDown
            disabled={busy}
            icon={<EyeIcon className="size-4" />}
            label={copy.t("openInFileViewerLabel")}
            onClick={() => {
              const openPromise = onOpenInFileViewer();
              onClose();
              void openPromise;
            }}
          />
        ) : null}
        {showOpenInAppBrowser ? (
          <ContextMenuActionButton
            activateOnPointerDown
            disabled={busy}
            icon={openInAppBrowserIcon ?? <WebIcon className="size-4" />}
            label={copy.t("openInAppBrowserLabel")}
            onClick={() => {
              const openPromise = onOpenInAppBrowser();
              onClose();
              void openPromise;
            }}
          />
        ) : null}
        {showExternalSection ? <ContextMenuDivider /> : null}
        {isLoading ? (
          <div className="px-2 py-1.5 text-[11px] text-[var(--text-tertiary)]">
            {copy.t("openWithLoadingLabel")}
          </div>
        ) : null}
        {applications.map((application) => {
          const resolvedIcon = resolveOpenWithApplicationIcon?.(application);

          return (
            <ContextMenuActionButton
              activateOnPointerDown
              key={application.applicationPath}
              disabled={busy}
              icon={
                resolvedIcon ??
                (application.iconDataUrl ? (
                  <img
                    alt=""
                    className="size-4 rounded-[4px] object-contain"
                    src={application.iconDataUrl}
                  />
                ) : (
                  <EyeIcon className="size-4" />
                ))
              }
              label={application.name}
              onClick={() => {
                const openPromise = onOpenWithApplication(
                  application.applicationPath
                );
                onClose();
                void openPromise;
              }}
            />
          );
        })}
        {showOpenInDefaultBrowser ? (
          <ContextMenuActionButton
            activateOnPointerDown
            disabled={busy}
            icon={<WebIcon className="size-4" />}
            label={copy.t("openInDefaultBrowserLabel")}
            onClick={() => {
              const openPromise = onOpenInDefaultBrowser();
              onClose();
              void openPromise;
            }}
          />
        ) : null}
        {showOpenWithOther ? (
          <ContextMenuActionButton
            activateOnPointerDown
            disabled={busy}
            icon={<LaunchIcon className="size-4" />}
            label={copy.t("openWithOtherLabel")}
            onClick={() => {
              const openPromise = onOpenWithOtherApplication();
              onClose();
              void openPromise;
            }}
          />
        ) : null}
      </ViewportMenuSurface>
    </div>
  );
}
