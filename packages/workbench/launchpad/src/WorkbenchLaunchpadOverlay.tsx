import type * as React from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { WorkbenchDockPlacement } from "@tutti-os/workbench-surface";
import {
  CloseIcon,
  NavApplicationsFilledIcon,
  SearchIcon
} from "@tutti-os/ui-system";
import {
  filterWorkbenchLaunchpadItems,
  paginateWorkbenchLaunchpadItems,
  resolveWorkbenchLaunchpadGrid,
  type WorkbenchLaunchpadGridMetrics,
  type WorkbenchLaunchpadItem
} from "./launchpadModel.ts";
import {
  createWorkbenchLaunchpadWheelNavigationState,
  resolveWorkbenchLaunchpadWheelNavigation
} from "./launchpadWheelNavigation.ts";

export interface WorkbenchLaunchpadOverlayCopy {
  clearSearch: string;
  empty: string;
  installAction?: string;
  installingAction?: string;
  label: string;
  pageDot?: (input: { page: number; pageCount: number }) => string;
  pages?: string;
  refreshAction?: string;
  searchPlaceholder: string;
  syncAction?: string;
  unavailableItem?: (input: { reason: string; title: string }) => string;
}

export interface WorkbenchLaunchpadOverlayProps<
  TProvider extends string = string
> {
  copy: WorkbenchLaunchpadOverlayCopy;
  dockPlacement?: WorkbenchDockPlacement;
  getAgentActionPending?: (
    item: Extract<WorkbenchLaunchpadItem<TProvider>, { kind: "agent" }>,
    actionId: string
  ) => boolean;
  getAgentActionLabel?: (actionId: string) => string;
  getAgentReason?: (
    item: Extract<WorkbenchLaunchpadItem<TProvider>, { kind: "agent" }>
  ) => string | null;
  items: readonly WorkbenchLaunchpadItem<TProvider>[];
  onClose: () => void;
  onLaunchItem: (item: WorkbenchLaunchpadItem<TProvider>) => void;
  onPageChange?: (input: { pageIndex: number; totalPages: number }) => void;
  onRunAgentAction?: (
    item: Extract<WorkbenchLaunchpadItem<TProvider>, { kind: "agent" }>,
    actionId: string
  ) => void;
  onSearch?: (input: { queryLength: number; resultCount: number }) => void;
  open: boolean;
}

const defaultLaunchpadGrid: WorkbenchLaunchpadGridMetrics = {
  columns: 5,
  pageSize: 15,
  rows: 3
};
const launchpadExitAnimationMs = 180;
const launchpadHoverPanelViewportInsetPx = 16;

type WorkbenchLaunchpadAgentItem<TProvider extends string = string> = Extract<
  WorkbenchLaunchpadItem<TProvider>,
  { kind: "agent" }
>;

export function WorkbenchLaunchpadOverlay<TProvider extends string = string>({
  copy,
  dockPlacement = "bottom",
  getAgentActionLabel,
  getAgentActionPending,
  getAgentReason,
  items,
  onClose,
  onLaunchItem,
  onPageChange,
  onRunAgentAction,
  onSearch,
  open
}: WorkbenchLaunchpadOverlayProps<TProvider>) {
  const [query, setQuery] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [shouldRender, setShouldRender] = useState(open);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const wheelNavigationRef = useRef(
    createWorkbenchLaunchpadWheelNavigationState()
  );
  const { grid, ref: gridViewportRef } = useLaunchpadGridMetrics(open);
  const isClosing = shouldRender && !open;
  const filteredItems = useMemo(
    () => filterWorkbenchLaunchpadItems(items, query),
    [items, query]
  );
  const page = useMemo(
    () =>
      paginateWorkbenchLaunchpadItems(filteredItems, {
        page: pageIndex,
        pageSize: grid.pageSize
      }),
    [filteredItems, grid.pageSize, pageIndex]
  );

  useEffect(() => {
    if (open) {
      setShouldRender(true);
      return undefined;
    }
    if (!shouldRender) {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      setShouldRender(false);
    }, launchpadExitAnimationMs);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [open, shouldRender]);

  useEffect(() => {
    if (!open) {
      wheelNavigationRef.current =
        createWorkbenchLaunchpadWheelNavigationState();
      return;
    }
    setQuery("");
    setPageIndex(0);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    setPageIndex(0);
    wheelNavigationRef.current = createWorkbenchLaunchpadWheelNavigationState();
  }, [query]);

  useEffect(() => {
    if (!open || !onSearch) {
      return undefined;
    }
    const queryLength = query.trim().length;
    if (queryLength === 0) {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      onSearch({
        queryLength,
        resultCount: filteredItems.length
      });
    }, 300);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [filteredItems.length, onSearch, open, query]);

  const changePage = useCallback(
    (nextPageIndex: number) => {
      setPageIndex((currentPageIndex) => {
        const clampedPageIndex = Math.max(
          0,
          Math.min(nextPageIndex, page.pageCount - 1)
        );
        if (clampedPageIndex !== currentPageIndex) {
          onPageChange?.({
            pageIndex: clampedPageIndex,
            totalPages: page.pageCount
          });
        }
        return clampedPageIndex;
      });
    },
    [onPageChange, page.pageCount]
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (isTextInputTarget(event.target)) {
        return;
      }
      if (event.key === "ArrowRight" && page.pageCount > 1) {
        event.preventDefault();
        changePage(page.currentPage + 1);
        return;
      }
      if (event.key === "ArrowLeft" && page.pageCount > 1) {
        event.preventDefault();
        changePage(page.currentPage - 1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [changePage, onClose, open, page.currentPage, page.pageCount]);

  const handleOverlayClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (isClosing || isLaunchpadInteractiveTarget(event.target)) {
        return;
      }
      onClose();
    },
    [isClosing, onClose]
  );
  const handleOverlayWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!open || isClosing || isLaunchpadWheelIgnoredTarget(event.target)) {
        return;
      }

      const result = resolveWorkbenchLaunchpadWheelNavigation({
        currentPage: page.currentPage,
        deltaMode: event.deltaMode,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        pageCount: page.pageCount,
        state: wheelNavigationRef.current,
        timestamp: event.timeStamp
      });
      wheelNavigationRef.current = result.state;
      if (result.shouldPreventDefault) {
        event.preventDefault();
      }
      if (result.nextPageIndex !== null) {
        changePage(result.nextPageIndex);
      }
    },
    [changePage, isClosing, open, page.currentPage, page.pageCount]
  );

  if (!shouldRender) {
    return null;
  }

  return (
    <div
      aria-label={copy.label}
      aria-modal="false"
      className={classNames(
        "workspace-launchpad-overlay",
        isClosing && "workspace-launchpad-overlay--closing"
      )}
      role="dialog"
      onClick={handleOverlayClick}
      onWheel={handleOverlayWheel}
    >
      <button
        aria-hidden="true"
        className="workspace-launchpad-overlay__dismiss"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        className="workspace-launchpad-overlay__content"
        data-dock-placement={dockPlacement}
      >
        <div className="workspace-launchpad-overlay__topbar">
          <div className="workspace-launchpad-search">
            <span
              aria-hidden="true"
              className="workspace-launchpad-search__icon"
            >
              <SearchIcon />
            </span>
            <input
              ref={searchInputRef}
              aria-label={copy.searchPlaceholder}
              className="workspace-launchpad-search__input"
              placeholder={copy.searchPlaceholder}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button
                aria-label={copy.clearSearch}
                className="workspace-launchpad-search__clear"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                <CloseIcon />
              </button>
            ) : null}
          </div>
        </div>
        <div
          ref={gridViewportRef}
          className="workspace-launchpad-grid-viewport"
        >
          {filteredItems.length === 0 ? (
            <div className="workspace-launchpad-empty">{copy.empty}</div>
          ) : (
            <div
              className="workspace-launchpad-grid"
              style={{
                gridTemplateColumns: `repeat(${grid.columns}, minmax(96px, 136px))`
              }}
            >
              {page.pageItems.map((item, index) => (
                <WorkbenchLaunchpadItemButton
                  key={item.id}
                  animationIndex={index}
                  animationRisePx={18 + (index % grid.columns) * 3}
                  copy={copy}
                  getAgentActionLabel={getAgentActionLabel}
                  getAgentReason={getAgentReason}
                  isAgentActionPending={getAgentActionPending}
                  item={item}
                  onLaunch={onLaunchItem}
                  onRunAgentAction={onRunAgentAction}
                />
              ))}
            </div>
          )}
        </div>
        {page.pageCount > 1 ? (
          <div
            aria-label={copy.pages ?? "Pages"}
            className="workspace-launchpad-pages"
          >
            {Array.from({ length: page.pageCount }, (_, index) => (
              <button
                key={index}
                aria-label={
                  copy.pageDot?.({
                    page: index + 1,
                    pageCount: page.pageCount
                  }) ?? `${index + 1} / ${page.pageCount}`
                }
                className="workspace-launchpad-page-dot"
                data-active={index === page.currentPage ? "true" : undefined}
                type="button"
                onClick={() => changePage(index)}
              />
            ))}
          </div>
        ) : (
          <div aria-hidden="true" className="workspace-launchpad-pages" />
        )}
      </div>
    </div>
  );
}

function WorkbenchLaunchpadItemButton<TProvider extends string = string>({
  animationIndex,
  animationRisePx,
  copy,
  getAgentActionLabel,
  getAgentReason,
  isAgentActionPending,
  item,
  onLaunch,
  onRunAgentAction
}: {
  animationIndex: number;
  animationRisePx: number;
  copy: WorkbenchLaunchpadOverlayCopy;
  getAgentActionLabel?: (actionId: string) => string;
  getAgentReason?: (
    item: WorkbenchLaunchpadAgentItem<TProvider>
  ) => string | null;
  isAgentActionPending?: (
    item: WorkbenchLaunchpadAgentItem<TProvider>,
    actionId: string
  ) => boolean;
  item: WorkbenchLaunchpadItem<TProvider>;
  onLaunch: (item: WorkbenchLaunchpadItem<TProvider>) => void;
  onRunAgentAction?: (
    item: WorkbenchLaunchpadAgentItem<TProvider>,
    actionId: string
  ) => void;
}) {
  const disabledLabel =
    item.disabledReason === undefined
      ? null
      : (copy.unavailableItem?.({
          reason: item.disabledReason,
          title: item.label
        }) ?? item.disabledReason);
  const [hoverPanelOpen, setHoverPanelOpen] = useState(false);
  const [hoverPanelShift, setHoverPanelShift] = useState(0);
  const hoverPanelRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentActions =
    item.kind === "agent" && !item.launchEnabled
      ? resolveLaunchpadAgentActions(item)
      : [];
  const agentReason =
    item.kind === "agent"
      ? (getAgentReason?.(item) ?? item.reason ?? null)
      : null;
  const showComingSoonTooltip =
    item.kind === "agent" && item.comingSoon === true && agentReason !== null;
  const showAgentHoverPanel =
    item.kind === "agent" &&
    item.comingSoon !== true &&
    !item.launchEnabled &&
    hoverPanelOpen &&
    (agentActions.length > 0 || agentReason !== null);
  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current === null) {
      return;
    }
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }, []);

  useEffect(
    () => () => {
      clearHoverTimer();
    },
    [clearHoverTimer]
  );

  useLayoutEffect(() => {
    if (!showAgentHoverPanel || typeof window === "undefined") {
      setHoverPanelShift(0);
      return undefined;
    }

    const frameId = window.requestAnimationFrame(() => {
      const panel = hoverPanelRef.current;
      if (!panel) {
        return;
      }

      const rect = panel.getBoundingClientRect();
      const maxRight = window.innerWidth - launchpadHoverPanelViewportInsetPx;
      const nextShift =
        rect.left < launchpadHoverPanelViewportInsetPx
          ? launchpadHoverPanelViewportInsetPx - rect.left
          : rect.right > maxRight
            ? maxRight - rect.right
            : 0;

      setHoverPanelShift((current) =>
        current === nextShift ? current : nextShift
      );
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [agentActions.length, agentReason, showAgentHoverPanel]);

  const handlePointerEnter = useCallback(() => {
    if (item.kind !== "agent" || item.launchEnabled || item.comingSoon) {
      return;
    }
    clearHoverTimer();
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      setHoverPanelOpen(true);
    }, 500);
  }, [clearHoverTimer, item]);
  const handlePointerLeave = useCallback(() => {
    clearHoverTimer();
    setHoverPanelOpen(false);
  }, [clearHoverTimer]);
  const animationStyle = {
    "--workspace-launchpad-item-delay": `${Math.min(animationIndex, 24) * 28}ms`,
    "--workspace-launchpad-item-rise": `${animationRisePx}px`
  } as React.CSSProperties;
  const itemNode = (
    <div
      className="workspace-launchpad-item-wrap"
      style={animationStyle}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <button
        aria-label={disabledLabel ?? item.label}
        className={classNames(
          "workspace-launchpad-item",
          !item.launchEnabled && "workspace-launchpad-item--disabled"
        )}
        disabled={!item.launchEnabled}
        title={
          showComingSoonTooltip ? undefined : (disabledLabel ?? item.label)
        }
        type="button"
        onClick={() => onLaunch(item)}
      >
        <span
          aria-hidden="true"
          className="workspace-launchpad-item__icon"
          data-workspace-app-icon={item.iconUrl ? "true" : undefined}
        >
          {item.iconUrl ? (
            <img alt="" draggable={false} src={item.iconUrl} />
          ) : (
            <NavApplicationsFilledIcon className="size-10" />
          )}
        </span>
        <span className="workspace-launchpad-item__label">{item.label}</span>
      </button>
      {showAgentHoverPanel ? (
        <div
          ref={hoverPanelRef}
          className="desktop-dock__hover-panel workspace-launchpad-dock-hover-panel"
          role="group"
          style={
            {
              "--workspace-launchpad-hover-panel-shift": `${Math.round(
                hoverPanelShift
              )}px`
            } as React.CSSProperties
          }
        >
          <div className="desktop-dock__hover-panel-title">{item.label}</div>
          {agentReason ? (
            <div className="desktop-dock__hover-panel-description">
              {agentReason}
            </div>
          ) : null}
          {agentActions.length ? (
            <div className="desktop-dock__hover-actions">
              {agentActions.map((action) => {
                const isPending =
                  isAgentActionPending?.(item, action.id) ?? false;
                return (
                  <button
                    key={action.id}
                    aria-busy={isPending || undefined}
                    className="desktop-dock__hover-action"
                    disabled={isPending}
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (isPending) {
                        return;
                      }
                      onRunAgentAction?.(item, action.id);
                    }}
                  >
                    {resolveAgentActionLabel(
                      isPending && action.id === "install"
                        ? "installing"
                        : action.id,
                      copy,
                      getAgentActionLabel
                    )}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return showComingSoonTooltip ? (
    <span
      className="workspace-launchpad-tooltip-host"
      title={agentReason ?? undefined}
    >
      {itemNode}
    </span>
  ) : (
    itemNode
  );
}

function useLaunchpadGridMetrics(open: boolean): {
  grid: WorkbenchLaunchpadGridMetrics;
  ref: React.RefObject<HTMLDivElement | null>;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [grid, setGrid] =
    useState<WorkbenchLaunchpadGridMetrics>(defaultLaunchpadGrid);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const element = ref.current;
    if (!element) {
      return undefined;
    }

    const update = () => {
      const rect = element.getBoundingClientRect();
      setGrid(
        resolveWorkbenchLaunchpadGrid({
          height: rect.height,
          width: rect.width
        })
      );
    };
    update();

    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(element);
    return () => {
      resizeObserver.disconnect();
    };
  }, [open]);

  return { grid, ref };
}

function resolveLaunchpadAgentActions<TProvider extends string>(
  item: WorkbenchLaunchpadAgentItem<TProvider>
) {
  if (item.comingSoon) {
    return [];
  }
  if (item.actions?.length) {
    return item.actions;
  }
  if (item.action) {
    return [{ id: item.action }];
  }
  return [];
}

function resolveAgentActionLabel(
  actionId: string,
  copy: WorkbenchLaunchpadOverlayCopy,
  getAgentActionLabel: ((actionId: string) => string) | undefined
): string {
  if (getAgentActionLabel) {
    return getAgentActionLabel(actionId);
  }
  switch (actionId) {
    case "install":
      return copy.installAction ?? actionId;
    case "installing":
      return copy.installingAction ?? copy.installAction ?? actionId;
    case "sync":
      return copy.syncAction ?? actionId;
    default:
      return copy.refreshAction ?? actionId;
  }
}

function isTextInputTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isLaunchpadInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(
      target.closest(
        ".workspace-launchpad-overlay__topbar, .workspace-launchpad-search, .workspace-launchpad-item, .desktop-dock__hover-panel, .workspace-launchpad-pages"
      )
    )
  );
}

function isLaunchpadWheelIgnoredTarget(target: EventTarget | null): boolean {
  return (
    isTextInputTarget(target) ||
    (target instanceof HTMLElement &&
      Boolean(
        target.closest(
          ".workspace-launchpad-overlay__topbar, .workspace-launchpad-search, .desktop-dock__hover-panel, .workspace-launchpad-pages"
        )
      ))
  );
}

function classNames(
  ...values: readonly (string | false | null | undefined)[]
): string {
  return values.filter(Boolean).join(" ");
}
