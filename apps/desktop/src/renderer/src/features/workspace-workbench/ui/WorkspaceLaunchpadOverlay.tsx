import type * as React from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type {
  WorkbenchDockPlacement,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import { defaultIssueManagerWorkbenchTypeId } from "@tutti-os/workspace-issue-manager/workbench";
import type { DesktopDockIconStyle } from "@shared/preferences";
import type { DesktopThemeAppearance } from "@shared/theme";
import {
  Button,
  CloseIcon,
  Input,
  NavApplicationsFilledIcon,
  SearchIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import { useService } from "@tutti-os/infra/di";
import {
  IAgentProviderStatusService,
  requestWorkspaceAgentGuiLaunch
} from "@renderer/features/workspace-agent";
import { IReporterService } from "@renderer/features/analytics";
import { normalizeDesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState";
import {
  shouldShowWorkspaceApp,
  useWorkspaceAppCenterService,
  workspaceAppCenterNodeID
} from "@renderer/features/workspace-app-center";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import {
  isWorkspaceAgentGuiComingSoonProvider,
  resolveWorkspaceAgentGuiLabel,
  workspaceAgentGuiProviders
} from "../services/workspaceAgentProviderCatalog.ts";
import {
  createWorkspaceLaunchpadAnalyticsController,
  type WorkspaceLaunchpadAnalyticsController,
  type WorkspaceLaunchpadAnalyticsItemType,
  type WorkspaceLaunchpadOpenTrigger
} from "../services/workspaceLaunchpadAnalytics.ts";
import {
  buildWorkspaceLaunchpadItems,
  filterWorkspaceLaunchpadItems,
  paginateWorkspaceLaunchpadItems,
  resolveWorkspaceLaunchpadGrid,
  type WorkspaceLaunchpadGridMetrics,
  type WorkspaceLaunchpadItem
} from "../services/workspaceLaunchpadModel.ts";
import { resolveWorkspaceDockIconSet } from "../services/workspaceDockIconStyle.ts";
import {
  defaultWorkspaceTerminalWorkbenchTypeId,
  workspaceBrowserNodeID,
  workspaceFilesNodeID
} from "../services/workspaceWorkbenchNodeIds.ts";

const defaultLaunchpadGrid: WorkspaceLaunchpadGridMetrics = {
  columns: 5,
  pageSize: 15,
  rows: 3
};
const launchpadExitAnimationMs = 180;
const launchpadHoverPanelViewportInsetPx = 16;
type WorkspaceLaunchpadAgentItem = Extract<
  WorkspaceLaunchpadItem,
  { kind: "agent" }
>;
type WorkspaceLaunchpadTranslate = ReturnType<typeof useTranslation>["t"];

export function WorkspaceLaunchpadOverlay({
  dockIconStyle,
  dockPlacement,
  host,
  onClose,
  open,
  openTrigger,
  themeAppearance,
  workspaceId
}: {
  dockIconStyle: DesktopDockIconStyle;
  dockPlacement: WorkbenchDockPlacement;
  host: WorkbenchHostHandle | null;
  onClose: () => void;
  open: boolean;
  openTrigger: WorkspaceLaunchpadOpenTrigger;
  themeAppearance: DesktopThemeAppearance;
  workspaceId: string;
}) {
  const { service: appCenterService, state: appCenterState } =
    useWorkspaceAppCenterService();
  const agentProviderStatusService = useService(IAgentProviderStatusService);
  const reporterService = useService(IReporterService);
  const agentProviderSnapshot = useSyncExternalStore(
    (listener) => agentProviderStatusService.subscribe(listener),
    () => agentProviderStatusService.getSnapshot(),
    () => agentProviderStatusService.getSnapshot()
  );
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [shouldRender, setShouldRender] = useState(open);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const wasOpenRef = useRef(false);
  const { grid, ref: gridViewportRef } = useLaunchpadGridMetrics(open);
  const isClosing = shouldRender && !open;
  const launchpadAnalytics = useMemo(
    () =>
      createWorkspaceLaunchpadAnalyticsController({
        reporterService
      }),
    [reporterService]
  );
  const launchpadDockIcons = useMemo(
    () =>
      resolveWorkspaceDockIconSet({
        appearance: themeAppearance,
        style: dockIconStyle
      }),
    [dockIconStyle, themeAppearance]
  );

  const agentDescriptors = useMemo(
    () =>
      workspaceAgentGuiProviders.map((provider) => ({
        comingSoon: isWorkspaceAgentGuiComingSoonProvider(provider),
        iconUrl: launchpadDockIcons.agents[provider],
        label:
          provider === "nexight"
            ? "Tutti"
            : resolveWorkspaceAgentGuiLabel(provider),
        provider
      })),
    [launchpadDockIcons.agents]
  );
  const nodeDescriptors = useMemo(
    () => [
      {
        dockEntryId: workspaceAppCenterNodeID,
        iconUrl: launchpadDockIcons.applications,
        id: workspaceAppCenterNodeID,
        label: t("workspace.workbenchDesktop.nodes.appCenter"),
        typeId: workspaceAppCenterNodeID
      },
      {
        dockEntryId: defaultIssueManagerWorkbenchTypeId,
        iconUrl: launchpadDockIcons.issue,
        id: defaultIssueManagerWorkbenchTypeId,
        label: t("workspace.workbenchDesktop.nodes.issues"),
        typeId: defaultIssueManagerWorkbenchTypeId
      },
      {
        dockEntryId: workspaceFilesNodeID,
        iconUrl: launchpadDockIcons.files,
        id: workspaceFilesNodeID,
        label: t("workspace.workbenchDesktop.nodes.files"),
        typeId: workspaceFilesNodeID
      },
      {
        dockEntryId: workspaceBrowserNodeID,
        iconUrl: launchpadDockIcons.browser,
        id: workspaceBrowserNodeID,
        label: t("workspace.workbenchDesktop.nodes.browser"),
        typeId: workspaceBrowserNodeID
      },
      {
        dockEntryId: defaultWorkspaceTerminalWorkbenchTypeId,
        iconUrl: launchpadDockIcons.terminal,
        id: defaultWorkspaceTerminalWorkbenchTypeId,
        label: t("workspace.workbenchDesktop.nodes.terminal"),
        typeId: defaultWorkspaceTerminalWorkbenchTypeId
      }
    ],
    [launchpadDockIcons, t]
  );
  const launchpadApps = useMemo(
    () =>
      appCenterState.apps
        .filter((app) => shouldShowWorkspaceApp(app.appId))
        .map((app) => {
          const overrideIconUrl = launchpadDockIcons.appIconUrl(app.appId);
          return overrideIconUrl ? { ...app, iconUrl: overrideIconUrl } : app;
        }),
    [appCenterState.apps, launchpadDockIcons]
  );
  const items = useMemo(
    () =>
      buildWorkspaceLaunchpadItems({
        agentDescriptors,
        agentStatuses: agentProviderSnapshot.statuses,
        apps: launchpadApps,
        copy: {
          agentComingSoon: t(
            "workspace.workbenchDesktop.agentProviders.comingSoon"
          ),
          agentUnavailable: t(
            "workspace.workbenchDesktop.launchpad.agentUnavailable"
          ),
          appUnavailable: t(
            "workspace.workbenchDesktop.launchpad.appUnavailable"
          )
        },
        nodeDescriptors
      }),
    [
      agentDescriptors,
      agentProviderSnapshot.statuses,
      launchpadApps,
      nodeDescriptors,
      t
    ]
  );
  const filteredItems = useMemo(
    () => filterWorkspaceLaunchpadItems(items, query),
    [items, query]
  );
  const page = useMemo(
    () =>
      paginateWorkspaceLaunchpadItems(filteredItems, {
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
      wasOpenRef.current = false;
      return;
    }
    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      launchpadAnalytics.opened({
        totalItems: items.length,
        trigger: openTrigger
      });
    }
    setQuery("");
    setPageIndex(0);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [items.length, launchpadAnalytics, open, openTrigger]);

  useEffect(() => {
    setPageIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const queryLength = query.trim().length;
    if (queryLength === 0) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      launchpadAnalytics.searched({
        queryLength,
        resultCount: filteredItems.length
      });
    }, 300);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [filteredItems.length, launchpadAnalytics, open, query]);

  const changePage = useCallback(
    (nextPageIndex: number) => {
      setPageIndex((currentPageIndex) => {
        const clampedPageIndex = Math.max(
          0,
          Math.min(nextPageIndex, page.pageCount - 1)
        );
        if (clampedPageIndex !== currentPageIndex) {
          launchpadAnalytics.pageChanged({
            pageIndex: clampedPageIndex,
            totalPages: page.pageCount
          });
        }
        return clampedPageIndex;
      });
    },
    [launchpadAnalytics, page.pageCount]
  );

  const closeLaunchpad = useCallback(() => {
    launchpadAnalytics.closed();
    onClose();
  }, [launchpadAnalytics, onClose]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeLaunchpad();
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
  }, [changePage, closeLaunchpad, open, page.currentPage, page.pageCount]);

  const launchItem = useCallback(
    (item: WorkspaceLaunchpadItem) => {
      if (!item.launchEnabled) {
        return;
      }

      launchpadAnalytics.itemLaunched(
        resolveLaunchpadAnalyticsItem(item, query)
      );
      closeLaunchpad();
      if (item.kind === "app") {
        void appCenterService
          .openApp({
            appId: item.appId,
            workspaceId
          })
          .catch(noop);
        return;
      }
      if (item.kind === "node") {
        void host
          ?.launchNode({
            dockEntryId: item.dockEntryId,
            reason: "launchpad",
            typeId: item.typeId
          })
          .catch(noop);
        return;
      }

      void requestWorkspaceAgentGuiLaunch({
        provider: normalizeDesktopAgentGUIProvider(item.provider),
        workspaceId
      }).catch(noop);
    },
    [
      appCenterService,
      closeLaunchpad,
      host,
      launchpadAnalytics,
      query,
      workspaceId
    ]
  );
  const handleOverlayClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (isClosing) {
        return;
      }
      if (isLaunchpadInteractiveTarget(event.target)) {
        return;
      }
      closeLaunchpad();
    },
    [closeLaunchpad, isClosing]
  );

  if (!shouldRender) {
    return null;
  }

  return (
    <div
      aria-label={t("workspace.workbenchDesktop.launchpad.dockLabel")}
      aria-modal="false"
      className={cn(
        "workspace-launchpad-overlay",
        isClosing && "workspace-launchpad-overlay--closing"
      )}
      role="dialog"
      onClick={handleOverlayClick}
    >
      <button
        aria-hidden="true"
        className="workspace-launchpad-overlay__dismiss"
        tabIndex={-1}
        type="button"
        onClick={closeLaunchpad}
      />
      <div
        className="workspace-launchpad-overlay__content"
        data-dock-placement={dockPlacement}
      >
        <div className="workspace-launchpad-overlay__topbar">
          <div className="workspace-launchpad-search">
            <SearchIcon
              aria-hidden="true"
              className="workspace-launchpad-search__icon"
            />
            <Input
              ref={searchInputRef}
              aria-label={t(
                "workspace.workbenchDesktop.launchpad.searchPlaceholder"
              )}
              className="workspace-launchpad-search__input"
              placeholder={t(
                "workspace.workbenchDesktop.launchpad.searchPlaceholder"
              )}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button
                aria-label={t(
                  "workspace.workbenchDesktop.launchpad.clearSearch"
                )}
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
                <CloseIcon aria-hidden="true" size={16} />
              </button>
            ) : null}
          </div>
        </div>
        <div
          ref={gridViewportRef}
          className="workspace-launchpad-grid-viewport"
        >
          {filteredItems.length === 0 ? (
            <div className="workspace-launchpad-empty">
              {t("workspace.workbenchDesktop.launchpad.empty")}
            </div>
          ) : (
            <div
              className="workspace-launchpad-grid"
              style={{
                gridTemplateColumns: `repeat(${grid.columns}, minmax(96px, 136px))`
              }}
            >
              {page.pageItems.map((item, index) => (
                <WorkspaceLaunchpadItemButton
                  key={item.id}
                  animationIndex={index}
                  animationRisePx={18 + (index % grid.columns) * 3}
                  item={item}
                  unavailableLabel={(reason) =>
                    t("workspace.workbenchDesktop.launchpad.unavailableItem", {
                      reason,
                      title: item.label
                    })
                  }
                  getAgentActionLabel={(actionId) =>
                    resolveLaunchpadAgentActionLabel(actionId, t)
                  }
                  getAgentReason={(agent) =>
                    resolveLaunchpadAgentReason(agent, t)
                  }
                  isAgentActionPending={(agent, actionId) =>
                    agentProviderStatusService.isActionPending(
                      agent.provider,
                      actionId
                    )
                  }
                  onLaunch={launchItem}
                  onRunAgentAction={(agent, actionId) => {
                    closeLaunchpad();
                    void agentProviderStatusService
                      .runAction(agent.provider, actionId, {
                        workbenchHost: host ?? undefined,
                        workspaceId
                      })
                      .catch(noop);
                  }}
                />
              ))}
            </div>
          )}
        </div>
        {page.pageCount > 1 ? (
          <div
            aria-label={t("workspace.workbenchDesktop.launchpad.pages")}
            className="workspace-launchpad-pages"
          >
            {Array.from({ length: page.pageCount }, (_, index) => (
              <button
                key={index}
                aria-label={t("workspace.workbenchDesktop.launchpad.pageDot", {
                  page: index + 1,
                  pageCount: page.pageCount
                })}
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

function resolveLaunchpadAnalyticsItem(
  item: WorkspaceLaunchpadItem,
  query: string
): Parameters<WorkspaceLaunchpadAnalyticsController["itemLaunched"]>[0] {
  if (item.kind === "app") {
    return {
      appId: item.appId,
      fromSearch: query.trim().length > 0,
      isComingSoon: false,
      itemType: "app",
      provider: null
    };
  }
  if (item.kind === "agent") {
    return {
      appId: null,
      fromSearch: query.trim().length > 0,
      isComingSoon: item.comingSoon,
      itemType: "agent",
      provider: item.provider
    };
  }

  return {
    appId: null,
    fromSearch: query.trim().length > 0,
    isComingSoon: false,
    itemType: resolveLaunchpadNodeItemType(item.typeId),
    provider: null
  };
}

function resolveLaunchpadNodeItemType(
  typeId: string
): WorkspaceLaunchpadAnalyticsItemType {
  switch (typeId) {
    case workspaceAppCenterNodeID:
      return "app_center";
    case workspaceBrowserNodeID:
      return "browser";
    case workspaceFilesNodeID:
      return "files";
    case defaultWorkspaceTerminalWorkbenchTypeId:
      return "terminal";
    case defaultIssueManagerWorkbenchTypeId:
      return "issue_manager";
    default:
      return "app";
  }
}

function WorkspaceLaunchpadItemButton({
  animationIndex,
  animationRisePx,
  getAgentActionLabel,
  getAgentReason,
  isAgentActionPending,
  item,
  onLaunch,
  onRunAgentAction,
  unavailableLabel
}: {
  animationIndex: number;
  animationRisePx: number;
  getAgentActionLabel: (actionId: string) => string;
  getAgentReason: (item: WorkspaceLaunchpadAgentItem) => string | null;
  isAgentActionPending: (
    item: WorkspaceLaunchpadAgentItem,
    actionId: string
  ) => boolean;
  item: WorkspaceLaunchpadItem;
  onLaunch: (item: WorkspaceLaunchpadItem) => void;
  onRunAgentAction: (
    item: WorkspaceLaunchpadAgentItem,
    actionId: string
  ) => void;
  unavailableLabel: (reason: string) => string;
}) {
  const disabledLabel =
    item.disabledReason === undefined
      ? null
      : unavailableLabel(item.disabledReason);
  const [hoverPanelOpen, setHoverPanelOpen] = useState(false);
  const [hoverPanelShift, setHoverPanelShift] = useState(0);
  const hoverPanelRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentActions =
    item.kind === "agent" && !item.launchEnabled
      ? resolveLaunchpadAgentActions(item)
      : [];
  const agentReason = item.kind === "agent" ? getAgentReason(item) : null;
  const showComingSoonTooltip =
    item.kind === "agent" && item.comingSoon && agentReason !== null;
  const showAgentHoverPanel =
    item.kind === "agent" &&
    !item.comingSoon &&
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
        className={cn(
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
          className="workspace-launchpad-item__icon"
          aria-hidden="true"
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
                const isPending = isAgentActionPending(item, action.id);
                return (
                  <Button
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
                      onRunAgentAction(item, action.id);
                    }}
                  >
                    {isPending && action.id === "install"
                      ? getAgentActionLabel("installing")
                      : getAgentActionLabel(action.id)}
                  </Button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return showComingSoonTooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>{itemNode}</TooltipTrigger>
      <TooltipContent side="top">{agentReason}</TooltipContent>
    </Tooltip>
  ) : (
    itemNode
  );
}

function useLaunchpadGridMetrics(open: boolean): {
  grid: WorkspaceLaunchpadGridMetrics;
  ref: React.RefObject<HTMLDivElement | null>;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [grid, setGrid] =
    useState<WorkspaceLaunchpadGridMetrics>(defaultLaunchpadGrid);

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
        resolveWorkspaceLaunchpadGrid({
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

function resolveLaunchpadAgentActions(item: WorkspaceLaunchpadAgentItem) {
  if (item.comingSoon) {
    return [];
  }
  if (item.status === null) {
    return [{ id: "refresh" }];
  }
  switch (item.status.availability.status) {
    case "not_installed":
      return item.status.actions.filter((action) => action.id === "install");
    case "auth_required":
      return item.status.actions.filter((action) => action.id === "login");
    case "ready":
      return [];
    default:
      return item.status.actions.length
        ? item.status.actions
        : [{ id: "refresh" }];
  }
}

function resolveLaunchpadAgentReason(
  item: WorkspaceLaunchpadAgentItem,
  t: WorkspaceLaunchpadTranslate
): string | null {
  if (item.comingSoon) {
    return t("workspace.workbenchDesktop.agentProviders.comingSoon");
  }
  if (item.status === null) {
    return t("workspace.workbenchDesktop.agentProviders.unknown");
  }
  switch (item.status.availability.status) {
    case "not_installed":
      return t("workspace.workbenchDesktop.agentProviders.installRequired");
    case "auth_required":
      return t("workspace.workbenchDesktop.agentProviders.loginRequired");
    case "ready":
      return null;
    default:
      return t("workspace.workbenchDesktop.agentProviders.unknown");
  }
}

function resolveLaunchpadAgentActionLabel(
  actionId: string,
  t: WorkspaceLaunchpadTranslate
): string {
  switch (actionId) {
    case "install":
      return t("workspace.workbenchDesktop.agentProviders.install");
    case "installing":
      return t("workspace.workbenchDesktop.agentProviders.installing");
    case "login":
      return t("workspace.workbenchDesktop.agentProviders.login");
    default:
      return t("workspace.workbenchDesktop.agentProviders.refresh");
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

function noop(): void {}
