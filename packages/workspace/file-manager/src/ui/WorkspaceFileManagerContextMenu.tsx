import {
  ArrowLeftIcon,
  ArrowRightIcon,
  LaunchIcon,
  MenuSurface,
  ViewportMenuSurface,
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
import { createPortal } from "react-dom";
import {
  OPEN_WITH_SUBMENU_WIDTH_PX,
  clampContextMenuPosition,
  estimateOpenWithSubmenuHeight,
  resolveOpenWithSubmenuPlacement,
  type OpenWithSubmenuPlacement
} from "./contextMenuPlacement.ts";
import type {
  WorkspaceFileManagerContextMenuItem,
  WorkspaceFileManagerContextMenuSubmenuItem
} from "./workspaceFileManagerContextMenuTypes.ts";

export interface WorkspaceFileManagerContextMenuProps {
  contextMenu: {
    x: number;
    y: number;
  } | null;
  contextMenuRef: RefObject<HTMLDivElement | null>;
  items: readonly WorkspaceFileManagerContextMenuItem[];
  positionMode?: "local" | "viewport";
  onClose: () => void;
}

export function WorkspaceFileManagerContextMenu({
  contextMenu,
  contextMenuRef,
  items,
  positionMode = "local",
  onClose
}: WorkspaceFileManagerContextMenuProps): ReactElement | null {
  const [position, setPosition] = useState({
    x: contextMenu?.x ?? 0,
    y: contextMenu?.y ?? 0
  });

  useLayoutEffect(() => {
    if (!contextMenu) {
      return;
    }
    setPosition((current) =>
      current.x === contextMenu.x && current.y === contextMenu.y
        ? current
        : { x: contextMenu.x, y: contextMenu.y }
    );
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
    const next = clampContextMenuPosition({
      boundaryHeight: boundaryRect?.height ?? window.innerHeight,
      boundaryWidth: boundaryRect?.width ?? window.innerWidth,
      menuHeight: menuRect.height,
      menuWidth: menuRect.width,
      x: contextMenu.x,
      y: contextMenu.y
    });
    // Bail out on identical coordinates — a fresh object every layout pass
    // retriggers render and can exceed React's maximum update depth.
    setPosition((current) =>
      current.x === next.x && current.y === next.y ? current : next
    );
  }, [contextMenu?.x, contextMenu?.y, contextMenuRef, items, positionMode]);

  if (!contextMenu || items.length === 0) {
    return null;
  }

  const menu = (
    <MenuSurface
      ref={contextMenuRef}
      data-workspace-file-manager-context-menu=""
      className={cn(
        // `is-open` keeps host CSS that keys off the class (not only data-state)
        // from leaving the surface at opacity:0.
        "is-open w-[220px] overflow-visible p-1",
        positionMode === "viewport" ? "fixed" : "absolute"
      )}
      role="menu"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        // Prefer the host CSS var when present; fall back to a stable stacking
        // value so an unset var cannot invalidate the entire z-index declaration.
        // Viewport menus need to clear typical workbench chrome (≈ z-10..50).
        zIndex:
          positionMode === "viewport"
            ? "var(--workspace-file-manager-dialog-overlay-z-index, 10050)"
            : "var(--workspace-file-manager-dialog-overlay-z-index, 20)"
      }}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      {items.map((item) => (
        <ContextMenuItemRenderer key={item.id} item={item} onClose={onClose} />
      ))}
    </MenuSurface>
  );

  // Viewport menus must leave overflow/contain ancestors (e.g. Agent tool
  // sidebar `[contain:layout_paint]`) or fixed coords are clipped off-screen.
  if (positionMode === "viewport" && typeof document !== "undefined") {
    return createPortal(menu, document.body);
  }

  return menu;
}

function ContextMenuItemRenderer({
  item,
  onClose,
  activateOnPointerDown = false
}: {
  activateOnPointerDown?: boolean;
  item: WorkspaceFileManagerContextMenuItem;
  onClose: () => void;
}): ReactElement | null {
  switch (item.type) {
    case "separator":
      return <ContextMenuDivider />;
    case "submenu":
      return <ContextMenuSubmenu item={item} onClose={onClose} />;
    case "item":
      return (
        <ContextMenuActionButton
          activateOnPointerDown={activateOnPointerDown}
          danger={item.danger}
          disabled={item.disabled}
          icon={item.icon ?? <LaunchIcon className="size-4" />}
          label={item.label}
          onClick={() => {
            onClose();
            void item.onSelect();
          }}
        />
      );
    default:
      return null;
  }
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

function ContextMenuSubmenu({
  item,
  onClose
}: {
  item: WorkspaceFileManagerContextMenuSubmenuItem;
  onClose: () => void;
}): ReactElement {
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const triggerButtonRef = useRef<HTMLButtonElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const focusSubmenuOnOpenRef = useRef(false);
  const [open, setOpen] = useState(false);
  const controlledChildren = item.children;
  const [asyncChildren, setAsyncChildren] = useState<
    readonly WorkspaceFileManagerContextMenuItem[] | null
  >(null);
  const [asyncLoading, setAsyncLoading] = useState(false);
  const [submenuPosition, setSubmenuPosition] =
    useState<OpenWithSubmenuPlacement>({
      left: 0,
      mode: "right",
      top: 0,
      width: OPEN_WITH_SUBMENU_WIDTH_PX
    });
  const closeTimerRef = useRef<number | null>(null);
  const children = controlledChildren ?? asyncChildren ?? [];
  const isLoading = Boolean(item.loading) || asyncLoading;
  const childActionCount = countRenderableMenuActions(children);
  const estimatedSubmenuHeight = estimateOpenWithSubmenuHeight({
    applicationCount: Math.max(0, childActionCount - 2),
    isLoading,
    showExternalSection: childActionCount > 0 || isLoading,
    showOpenInAppBrowser: false,
    showOpenInDefaultBrowser: false,
    showOpenInFileViewer: false,
    showOpenWithOther: false
  });

  useEffect(() => {
    if (controlledChildren !== undefined) {
      setAsyncChildren(null);
      setAsyncLoading(false);
    }
  }, [controlledChildren]);

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

  const ensureChildrenLoaded = useCallback(() => {
    if (
      controlledChildren !== undefined ||
      asyncChildren !== null ||
      !item.loadChildren ||
      asyncLoading
    ) {
      return;
    }
    setAsyncLoading(true);
    void item
      .loadChildren()
      .then((next) => {
        setAsyncChildren(next);
      })
      .catch(() => {
        setAsyncChildren([]);
      })
      .finally(() => {
        setAsyncLoading(false);
      });
  }, [asyncChildren, asyncLoading, controlledChildren, item]);

  const openSubmenu = useCallback(() => {
    focusSubmenuOnOpenRef.current = false;
    cancelClose();
    ensureChildrenLoaded();
    setOpen(true);
  }, [cancelClose, ensureChildrenLoaded]);

  const closeSubmenuToTrigger = useCallback(() => {
    cancelClose();
    setOpen(false);
    triggerButtonRef.current?.focus();
  }, [cancelClose]);

  const updateSubmenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    const triggerRect = trigger.getBoundingClientRect();
    const parentMenuRect =
      trigger
        .closest<HTMLElement>("[data-workspace-file-manager-context-menu]")
        ?.getBoundingClientRect() ?? triggerRect;
    const maxHeight = Math.min(
      estimatedSubmenuHeight,
      480,
      Math.max(0, window.innerHeight - 24)
    );
    setSubmenuPosition(
      resolveOpenWithSubmenuPlacement({
        parentMenuLeft: parentMenuRect.left,
        parentMenuTop: parentMenuRect.top,
        submenuHeight: maxHeight,
        triggerLeft: triggerRect.left,
        triggerRight: triggerRect.right,
        triggerTop: triggerRect.top,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth
      })
    );
  }, [estimatedSubmenuHeight]);

  useEffect(() => {
    return () => {
      cancelClose();
    };
  }, [cancelClose]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    updateSubmenuPosition();
  }, [open, updateSubmenuPosition, children.length, isLoading]);

  useEffect(() => {
    if (!open) {
      return;
    }
    window.addEventListener("resize", updateSubmenuPosition);
    window.addEventListener("scroll", updateSubmenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateSubmenuPosition);
      window.removeEventListener("scroll", updateSubmenuPosition, true);
    };
  }, [open, updateSubmenuPosition]);

  useEffect(() => {
    if (!open || !focusSubmenuOnOpenRef.current) {
      return;
    }
    focusSubmenuOnOpenRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      submenuRef.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open, submenuPosition.mode]);

  return (
    <div
      ref={triggerRef}
      className="relative"
      onPointerEnter={openSubmenu}
      onPointerLeave={scheduleClose}
    >
      <button
        ref={triggerButtonRef}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-[13px] text-[var(--text-primary)] transition-colors hover:bg-transparency-block disabled:cursor-default disabled:opacity-50",
          open && "bg-transparency-block"
        )}
        disabled={item.disabled}
        role="menuitem"
        type="button"
        onClick={(event) => {
          focusSubmenuOnOpenRef.current = event.detail === 0;
          setOpen((current) => {
            const next = !current;
            if (next) {
              cancelClose();
              ensureChildrenLoaded();
            } else {
              focusSubmenuOnOpenRef.current = false;
            }
            return next;
          });
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight") {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          focusSubmenuOnOpenRef.current = true;
          cancelClose();
          ensureChildrenLoaded();
          setOpen(true);
        }}
      >
        <span className="grid size-4 flex-none place-items-center text-[var(--text-secondary)]">
          {item.icon ?? <LaunchIcon className="size-4" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        <span
          aria-hidden="true"
          className="grid size-4 flex-none place-items-center text-[var(--text-tertiary)]"
        >
          <ArrowRightIcon className="size-4" />
        </span>
      </button>
      <ViewportMenuSurface
        ref={submenuRef}
        aria-label={item.label}
        data-workspace-file-manager-submenu=""
        data-workspace-file-manager-submenu-mode={submenuPosition.mode}
        open={open}
        className="max-h-[min(480px,calc(100vh-24px))] max-w-[calc(100vw-24px)] overflow-y-auto p-1"
        dismissOnEscape={false}
        dismissOnPointerDownOutside={false}
        dismissOnScroll={false}
        placement={{
          type: "absolute",
          left: submenuPosition.left,
          top: submenuPosition.top,
          boundaryPoint: { x: -1, y: -1 }
        }}
        role="menu"
        style={{
          width: submenuPosition.width,
          zIndex: "calc(var(--z-panel-popover) + 200)"
        }}
        onPointerEnter={openSubmenu}
        onPointerLeave={scheduleClose}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeSubmenuToTrigger();
            return;
          }
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
            return;
          }
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)"
            )
          );
          if (buttons.length === 0) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const currentIndex = buttons.indexOf(
            document.activeElement as HTMLButtonElement
          );
          const offset = event.key === "ArrowDown" ? 1 : -1;
          const nextIndex =
            currentIndex < 0
              ? offset > 0
                ? 0
                : buttons.length - 1
              : (currentIndex + offset + buttons.length) % buttons.length;
          buttons[nextIndex]?.focus();
        }}
      >
        {submenuPosition.mode === "overlay" ? (
          <>
            <ContextMenuActionButton
              activateOnPointerDown
              icon={<ArrowLeftIcon className="size-4" />}
              label={item.label}
              onClick={closeSubmenuToTrigger}
            />
            <ContextMenuDivider />
          </>
        ) : null}
        {isLoading ? (
          <div className="px-2 py-1.5 text-[11px] text-[var(--text-tertiary)]">
            {item.loadingLabel ?? "…"}
          </div>
        ) : null}
        {children.map((child) => (
          <ContextMenuItemRenderer
            key={child.id}
            activateOnPointerDown
            item={child}
            onClose={onClose}
          />
        ))}
      </ViewportMenuSurface>
    </div>
  );
}

function countRenderableMenuActions(
  items: readonly WorkspaceFileManagerContextMenuItem[]
): number {
  let count = 0;
  for (const item of items) {
    if (item.type === "item") {
      count += 1;
    } else if (item.type === "submenu") {
      count += 1 + countRenderableMenuActions(item.children ?? []);
    }
  }
  return count;
}
