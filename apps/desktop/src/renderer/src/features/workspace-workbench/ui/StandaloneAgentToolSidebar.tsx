import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type TransitionEvent
} from "react";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { selectWorkspaceAgentConsumerCounts } from "@tutti-os/agent-activity-core";
import type {
  WorkbenchContribution,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import { CloseIcon, cn } from "@tutti-os/ui-system";
import type { WorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import type { DesktopBrowserApi } from "@preload/types";
import {
  resolveWorkspaceAppDisplayName,
  useWorkspaceAppCenterService
} from "@renderer/features/workspace-app-center";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";
import { useTranslation } from "@renderer/i18n";
import type { StandaloneAgentIssueManagerOpenRequest } from "../services/standaloneAgentIssueManagerLaunch.ts";
import {
  createStandaloneAgentToolSidebarState,
  reduceStandaloneAgentToolSidebarState,
  standaloneAgentEmptyToolSidebarWidth,
  type StandaloneAgentToolPanelId,
  type StandaloneAgentToolTab
} from "./standaloneAgentToolSidebarModel.ts";
import { useStandaloneAgentToolSidebarLayout } from "./useStandaloneAgentToolSidebarLayout.ts";
import {
  StandaloneAgentToolSidebarToolbar,
  ToolSidebarPanelIcon,
  type ToolSidebarCopy,
  type ToolSidebarReminderCounts
} from "./StandaloneAgentToolSidebarToolbar.tsx";
import { createStandaloneAgentToolHostGroup } from "./standaloneAgentToolWorkbench.ts";
import { useExternalStoreValue } from "./useExternalStoreValue.ts";
import {
  StandaloneAgentToolSidebarPanel,
  type StandaloneAgentFileOpenRequest
} from "./StandaloneAgentToolSidebarPanel.tsx";
import { StandaloneAgentToolLoadingState } from "./StandaloneAgentToolLoadingState.tsx";
import { StandaloneAgentDecisionNotifications } from "./StandaloneAgentDecisionNotifications.tsx";
import { StandaloneAgentToolSidebarPicker } from "./StandaloneAgentToolSidebarPicker.tsx";

export type { StandaloneAgentFileOpenRequest } from "./StandaloneAgentToolSidebarPanel.tsx";
const standaloneAgentToolPanelContentMountDelayMs = 80;

interface StandaloneAgentToolSidebarProps {
  activityService: WorkspaceAgentActivityService;
  appOpenId?: string | null;
  appI18n: I18nRuntime<string>;
  browserApi?: DesktopBrowserApi;
  children: ReactNode;
  contributions: readonly WorkbenchContribution[] | undefined;
  fileOpenRequest?: StandaloneAgentFileOpenRequest | null;
  issueManagerOpenRequest?: StandaloneAgentIssueManagerOpenRequest | null;
  mainContentMinWidthPx?: number;
  renderHeader: (toolActions: ReactNode) => ReactNode;
  onOpenMessageCenterChat: (input: {
    agentSessionId: string;
    provider: string;
  }) => void;
  onAppsOpen: () => void;
  onAppendBrowserElementMention: (mention: string) => void;
  onBrowserElementError: (message: string) => void;
  onToolHostReady: (host: WorkbenchHostHandle | null) => void;
  resizeWindowContentWidth: (
    width: number,
    animate?: boolean
  ) => Promise<{ width: number }>;
  workspaceId: string;
}

export function StandaloneAgentToolSidebar({
  activityService,
  appOpenId = null,
  appI18n,
  browserApi,
  children,
  contributions,
  fileOpenRequest = null,
  issueManagerOpenRequest = null,
  mainContentMinWidthPx,
  renderHeader,
  onOpenMessageCenterChat,
  onAppsOpen,
  onAppendBrowserElementMention,
  onBrowserElementError,
  onToolHostReady,
  resizeWindowContentWidth,
  workspaceId
}: StandaloneAgentToolSidebarProps): ReactNode {
  const { i18n, locale } = useTranslation();
  const { service: appCenterService, state: appCenterState } =
    useWorkspaceAppCenterService();
  const [state, dispatch] = useReducer(
    reduceStandaloneAgentToolSidebarState,
    undefined,
    createStandaloneAgentToolSidebarState
  );
  const sessionEngine = useMemo(
    () => activityService.getSessionEngine(workspaceId),
    [activityService, workspaceId]
  );
  const messageCenterWorkingCount = useExternalStoreValue(
    sessionEngine.subscribe,
    () =>
      selectWorkspaceAgentConsumerCounts(sessionEngine.getSnapshot()).working,
    () =>
      selectWorkspaceAgentConsumerCounts(sessionEngine.getSnapshot()).working
  );
  const copy = useMemo<ToolSidebarCopy>(
    () => ({
      apps: i18n.t("workspace.agentGui.toolSidebar.apps"),
      browser: i18n.t("workspace.agentGui.toolSidebar.browser"),
      close: i18n.t("workspace.agentGui.toolSidebar.close"),
      closeRightPanel: i18n.t("workspace.agentGui.toolSidebar.closeRightPanel"),
      expand: i18n.t("workspace.agentGui.toolSidebar.expandPanel"),
      files: i18n.t("workspace.agentGui.toolSidebar.files"),
      messages: i18n.t("workspace.agentGui.toolSidebar.messages"),
      tasks: i18n.t("workspace.agentGui.toolSidebar.tasks"),
      newTab: i18n.t("workspace.agentGui.toolSidebar.newTab"),
      openRightPanel: i18n.t("workspace.agentGui.toolSidebar.openRightPanel"),
      shrink: i18n.t("workspace.agentGui.toolSidebar.shrinkPanel"),
      terminal: i18n.t("workspace.agentGui.toolSidebar.terminal"),
      tool: i18n.t("workspace.agentGui.toolSidebar.tool"),
      unavailable: i18n.t("workspace.agentGui.toolSidebar.unavailable")
    }),
    [i18n]
  );
  const reminders = useMemo<ToolSidebarReminderCounts>(
    () => ({
      messages: messageCenterWorkingCount
    }),
    [messageCenterWorkingCount]
  );
  const toolHostGroup = useMemo(createStandaloneAgentToolHostGroup, []);
  useEffect(() => {
    onToolHostReady(toolHostGroup.host);
    return () => {
      onToolHostReady(null);
    };
  }, [onToolHostReady, toolHostGroup]);
  const activePanel = state.activePanel;
  const activeTabId = state.activeTabId;
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isEmptySidebarClosing, setIsEmptySidebarClosing] = useState(false);
  const isEmptySidebar = isSidebarOpen && state.mountedTabs.length === 0;
  const isEmptySidebarSurface =
    (isSidebarOpen || isEmptySidebarClosing) && state.mountedTabs.length === 0;
  const layoutPanel = activePanel ?? (isEmptySidebarSurface ? "files" : null);
  const [contentReadyTabIds, setContentReadyTabIds] = useState<string[]>([]);
  const isActivePanelContentReady =
    activeTabId !== null && contentReadyTabIds.includes(activeTabId);
  const shouldAnimateSidebarLayout =
    state.mountedTabs.length === 0 || isActivePanelContentReady;
  const shouldAnimateSidebarWidth = isEmptySidebarSurface;
  const {
    activePanelLayoutWidth,
    activePanelMaxWidth,
    activePanelMinWidth,
    activePanelWidth,
    handleResizeKeyDown,
    handleResizePointerDown,
    handleResizePointerMove,
    isActivePanelExpanded,
    resizeForPanel,
    resetWindowResizeBaseline,
    stopResizing,
    togglePanelExpansion
  } = useStandaloneAgentToolSidebarLayout({
    activePanel: layoutPanel,
    activePanelPreferredWidth: isEmptySidebarSurface
      ? standaloneAgentEmptyToolSidebarWidth
      : undefined,
    mainContentMinWidthPx,
    resizeWindowContentWidth
  });
  const resizeAnimationFrameRef = useRef<number | null>(null);
  const scheduleResizeForPanel = useCallback(
    (
      panel: StandaloneAgentToolPanelId | null,
      preferredWidth?: number,
      options?: {
        animateWindow?: boolean;
        preserveBaseline?: boolean;
      }
    ) => {
      if (resizeAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeAnimationFrameRef.current);
      }
      resizeAnimationFrameRef.current = window.requestAnimationFrame(() => {
        resizeAnimationFrameRef.current = null;
        void resizeForPanel(panel, preferredWidth, options);
      });
    },
    [resizeForPanel]
  );
  useEffect(
    () => () => {
      if (resizeAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeAnimationFrameRef.current);
      }
    },
    []
  );
  const showSidebar = useCallback(() => {
    setIsEmptySidebarClosing(false);
    setIsSidebarOpen(true);
  }, []);
  useEffect(() => {
    if (!activeTabId || contentReadyTabIds.includes(activeTabId)) {
      return;
    }
    const delay = window.matchMedia?.("(prefers-reduced-motion: reduce)")
      .matches
      ? 0
      : standaloneAgentToolPanelContentMountDelayMs;
    const timer = window.setTimeout(() => {
      setContentReadyTabIds((current) =>
        current.includes(activeTabId) ? current : [...current, activeTabId]
      );
    }, delay);
    return () => window.clearTimeout(timer);
  }, [activeTabId, contentReadyTabIds]);
  const lastHandledAppOpenIdRef = useRef<string | null>(null);
  const lastHandledFileOpenRequestRef = useRef<string | null>(null);
  const fileOpenRequestTabIdRef = useRef<string | null>(null);
  const lastHandledIssueManagerOpenRequestRef = useRef<string | null>(null);
  const issueManagerOpenRequestTabIdRef = useRef<string | null>(null);
  useEffect(() => {
    const normalizedAppOpenId = appOpenId?.trim() || null;
    if (!normalizedAppOpenId) {
      lastHandledAppOpenIdRef.current = null;
      return;
    }
    if (lastHandledAppOpenIdRef.current === normalizedAppOpenId) {
      return;
    }
    lastHandledAppOpenIdRef.current = normalizedAppOpenId;
    onAppsOpen();
    showSidebar();
    dispatch({
      appId: normalizedAppOpenId,
      panel: "apps",
      tabId: resolveToolAppTabId(state.mountedTabs, normalizedAppOpenId),
      type: "open-panel"
    });
    scheduleResizeForPanel("apps");
  }, [
    appOpenId,
    onAppsOpen,
    scheduleResizeForPanel,
    showSidebar,
    state.mountedTabs
  ]);
  useEffect(() => {
    if (
      !fileOpenRequest ||
      lastHandledFileOpenRequestRef.current === fileOpenRequest.requestID
    ) {
      return;
    }
    lastHandledFileOpenRequestRef.current = fileOpenRequest.requestID;
    showSidebar();
    const filesTabId = resolveToolTabId(state.mountedTabs, "files");
    fileOpenRequestTabIdRef.current = filesTabId;
    dispatch({ panel: "files", tabId: filesTabId, type: "open-panel" });
    scheduleResizeForPanel("files");
  }, [fileOpenRequest, scheduleResizeForPanel, showSidebar, state.mountedTabs]);
  useEffect(() => {
    if (
      !issueManagerOpenRequest ||
      lastHandledIssueManagerOpenRequestRef.current ===
        issueManagerOpenRequest.requestID
    ) {
      return;
    }
    lastHandledIssueManagerOpenRequestRef.current =
      issueManagerOpenRequest.requestID;
    showSidebar();
    const tabId = resolveToolTabId(state.mountedTabs, "tasks");
    issueManagerOpenRequestTabIdRef.current = tabId;
    dispatch({ panel: "tasks", tabId, type: "open-panel" });
    scheduleResizeForPanel("tasks");
  }, [
    issueManagerOpenRequest,
    scheduleResizeForPanel,
    showSidebar,
    state.mountedTabs
  ]);
  const closePanel = useCallback(() => {
    setIsSidebarOpen(false);
    dispatch({ type: "close" });
    if (state.mountedTabs.length > 0) {
      setIsEmptySidebarClosing(false);
      scheduleResizeForPanel(null);
      return;
    }

    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    if (reducedMotion) {
      setIsEmptySidebarClosing(false);
      scheduleResizeForPanel(null);
      return;
    }

    setIsEmptySidebarClosing(true);
    scheduleResizeForPanel(null, undefined, {
      animateWindow: true,
      preserveBaseline: true
    });
  }, [scheduleResizeForPanel, state.mountedTabs.length]);
  const handleSidebarTransitionEnd = useCallback(
    (event: TransitionEvent<HTMLElement>) => {
      if (
        event.currentTarget !== event.target ||
        event.propertyName !== "width" ||
        isSidebarOpen ||
        !isEmptySidebarClosing
      ) {
        return;
      }
      setIsEmptySidebarClosing(false);
      resetWindowResizeBaseline();
    },
    [isEmptySidebarClosing, isSidebarOpen, resetWindowResizeBaseline]
  );
  const openPanel = useCallback(
    (panel: StandaloneAgentToolPanelId) => {
      showSidebar();
      if (panel === "apps") {
        onAppsOpen();
      }
      dispatch({
        panel,
        tabId: resolveToolTabId(state.mountedTabs, panel),
        type: "open-panel"
      });
      scheduleResizeForPanel(panel);
    },
    [onAppsOpen, scheduleResizeForPanel, showSidebar, state.mountedTabs]
  );
  const addPanel = useCallback(
    (panel: StandaloneAgentToolPanelId) => {
      showSidebar();
      if (panel === "apps") {
        onAppsOpen();
      }
      dispatch({ panel, tabId: createToolTabId(panel), type: "add-panel" });
      scheduleResizeForPanel(panel);
    },
    [onAppsOpen, scheduleResizeForPanel, showSidebar]
  );
  const toggleSidebar = useCallback(() => {
    const nextPanel = activePanel ?? "files";
    if (isSidebarOpen) {
      closePanel();
      return;
    }
    showSidebar();
    if (state.mountedTabs.length === 0) {
      const reducedMotion = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)"
      ).matches;
      scheduleResizeForPanel("files", standaloneAgentEmptyToolSidebarWidth, {
        animateWindow: !reducedMotion
      });
      return;
    }
    dispatch({
      panel: nextPanel,
      tabId: resolveToolTabId(state.mountedTabs, nextPanel),
      type: "open-panel"
    });
    scheduleResizeForPanel(nextPanel);
  }, [
    activePanel,
    closePanel,
    isSidebarOpen,
    scheduleResizeForPanel,
    showSidebar,
    state.mountedTabs
  ]);
  const closePanelTab = useCallback(
    (tabId: string) => {
      const closingTab = state.mountedTabs.find((tab) => tab.id === tabId);
      const closingIndex = state.mountedTabs.findIndex(
        (tab) => tab.id === tabId
      );
      const remainingTabs = state.mountedTabs.filter((tab) => tab.id !== tabId);
      const nextTab =
        activeTabId === tabId
          ? (remainingTabs[Math.max(0, closingIndex - 1)] ??
            remainingTabs[0] ??
            null)
          : (state.mountedTabs.find((tab) => tab.id === activeTabId) ?? null);
      setIsSidebarOpen(true);
      dispatch({ tabId, type: "close-tab" });
      if (closingTab?.panel === "apps" && closingTab.appId) {
        if (lastHandledAppOpenIdRef.current === closingTab.appId) {
          lastHandledAppOpenIdRef.current = null;
        }
        if (
          appCenterService.getViewState(workspaceId).openAppId ===
          closingTab.appId
        ) {
          appCenterService.setViewState({
            state: { openAppId: null },
            workspaceId
          });
        }
      }
      if (nextTab === null) {
        const reducedMotion = window.matchMedia?.(
          "(prefers-reduced-motion: reduce)"
        ).matches;
        scheduleResizeForPanel("files", standaloneAgentEmptyToolSidebarWidth, {
          animateWindow: !reducedMotion
        });
        return;
      }
      scheduleResizeForPanel(nextTab.panel);
    },
    [
      activeTabId,
      appCenterService,
      scheduleResizeForPanel,
      state.mountedTabs,
      workspaceId
    ]
  );
  useEffect(() => {
    if (appCenterState.catalogStatus !== "ready") {
      return;
    }
    const availableAppIds = new Set(
      appCenterState.apps.map((app) => app.appId)
    );
    for (const tab of state.mountedTabs) {
      if (
        tab.panel === "apps" &&
        tab.appId &&
        !availableAppIds.has(tab.appId)
      ) {
        closePanelTab(tab.id);
      }
    }
  }, [
    appCenterState.apps,
    appCenterState.catalogStatus,
    closePanelTab,
    state.mountedTabs
  ]);
  const activatePanelTab = useCallback(
    (tab: StandaloneAgentToolTab) => {
      if (tab.panel === "apps") {
        onAppsOpen();
      }
      dispatch({ tabId: tab.id, type: "activate-tab" });
      scheduleResizeForPanel(tab.panel);
    },
    [onAppsOpen, scheduleResizeForPanel]
  );

  return (
    <>
      <StandaloneAgentDecisionNotifications
        activityService={activityService}
        i18n={i18n}
        messageCenterOpen={activePanel === "messages"}
        workspaceId={workspaceId}
      />
      <div
        className="workbench-window__header workbench-window__header--custom"
        style={
          {
            "--agent-gui-tool-sidebar-layout-width": isSidebarOpen
              ? `${activePanelLayoutWidth}px`
              : "0px"
          } as CSSProperties
        }
      >
        {renderHeader(
          <div
            className={cn(
              "nodrag flex h-[var(--agent-gui-workbench-header-height,44px)] min-w-0 max-w-full shrink-0 items-center pr-[var(--agent-gui-workbench-header-padding-x)] [-webkit-app-region:no-drag]",
              isSidebarOpen && "border-b border-[var(--border-1)]"
            )}
            data-standalone-agent-tool-sidebar-header="true"
            style={
              isSidebarOpen
                ? {
                    width: `${activePanelWidth}px`,
                    maxWidth: "100%"
                  }
                : undefined
            }
          >
            {activeTabId ? (
              <ToolSidebarTabBar
                activeTabId={activeTabId}
                apps={appCenterState.apps}
                copy={copy}
                locale={locale}
                mountedTabs={state.mountedTabs}
                onClosePanel={closePanelTab}
                onOpenPanel={activatePanelTab}
              />
            ) : null}
            <StandaloneAgentToolSidebarToolbar
              activePanel={activePanel}
              copy={copy}
              isOpen={isSidebarOpen}
              isExpanded={isActivePanelExpanded}
              reminders={reminders}
              onAddPanel={addPanel}
              onOpenPanel={openPanel}
              onToggleExpansion={() => {
                if (activePanel) togglePanelExpansion(activePanel);
              }}
              onToggleSidebar={toggleSidebar}
            />
          </div>
        )}
      </div>
      <div className="workbench-window__body flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="h-full min-w-0 flex-1 overflow-hidden">
            {children}
          </div>
          <aside
            aria-hidden={!isSidebarOpen}
            className={cn(
              "relative h-full min-h-0 shrink-0 overflow-hidden [contain:layout_paint]",
              shouldAnimateSidebarWidth &&
                "motion-safe:transition-[width] motion-safe:duration-[260ms] motion-safe:ease-in-out motion-reduce:transition-none",
              isActivePanelExpanded && "border-l border-[var(--line-1)]",
              !isSidebarOpen && "pointer-events-none"
            )}
            data-standalone-agent-tool-sidebar="true"
            style={{
              width: isSidebarOpen ? `${activePanelLayoutWidth}px` : "0px",
              zIndex: "var(--z-panel)"
            }}
            onTransitionEnd={handleSidebarTransitionEnd}
          >
            <div
              className={cn(
                "absolute inset-y-0 right-0 flex flex-col bg-[var(--background-session-sidepanel)]",
                isSidebarOpen &&
                  !shouldAnimateSidebarLayout &&
                  "motion-safe:animate-in motion-safe:slide-in-from-right-3 motion-safe:duration-[160ms] motion-safe:ease-out motion-reduce:animate-none",
                !isSidebarOpen && !isEmptySidebarClosing && "invisible"
              )}
              style={
                {
                  "--background-panel": "var(--background-session-sidepanel)",
                  width: `${activePanelWidth}px`
                } as CSSProperties
              }
            >
              {isSidebarOpen && !isEmptySidebar ? (
                <div
                  aria-label={i18n.t(
                    "workspace.agentGui.toolSidebar.resizeSidebar"
                  )}
                  aria-orientation="vertical"
                  aria-valuemax={activePanelMaxWidth}
                  aria-valuemin={activePanelMinWidth}
                  aria-valuenow={activePanelWidth}
                  className="absolute top-0 left-0 z-20 h-full w-2 cursor-col-resize touch-none outline-none before:absolute before:left-0 before:h-full before:w-px before:bg-transparent hover:before:bg-[var(--border-focus)] focus-visible:before:bg-[var(--border-focus)]"
                  data-standalone-agent-tool-sidebar-resize-handle="true"
                  role="separator"
                  tabIndex={0}
                  onKeyDown={handleResizeKeyDown}
                  onLostPointerCapture={stopResizing}
                  onPointerDown={handleResizePointerDown}
                  onPointerMove={handleResizePointerMove}
                  onPointerUp={stopResizing}
                />
              ) : null}
              {isSidebarOpen ? (
                <div
                  aria-hidden
                  className="shrink-0"
                  data-standalone-agent-tool-sidebar-header-spacer="true"
                  style={{
                    height: "var(--agent-gui-workbench-header-height, 44px)"
                  }}
                />
              ) : null}
              <div className="relative min-h-0 flex-1 overflow-hidden">
                {isEmptySidebar || isEmptySidebarClosing ? (
                  <StandaloneAgentToolSidebarPicker
                    labels={{
                      apps: copy.apps,
                      browser: copy.browser,
                      files: copy.files,
                      messages: copy.messages,
                      tasks: copy.tasks,
                      terminal: copy.terminal
                    }}
                    onSelect={openPanel}
                  />
                ) : null}
                {state.mountedTabs.map((tab) => (
                  <div
                    aria-hidden={activeTabId !== tab.id}
                    className={cn(
                      "absolute inset-0 min-h-0 overflow-hidden",
                      activeTabId !== tab.id && "invisible pointer-events-none"
                    )}
                    key={tab.id}
                  >
                    {contentReadyTabIds.includes(tab.id) ? (
                      <div
                        className={cn(
                          "h-full min-h-0",
                          tab.panel !== "terminal" &&
                            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-reduce:animate-none"
                        )}
                      >
                        <StandaloneAgentToolSidebarPanel
                          active={activeTabId === tab.id}
                          appI18n={appI18n}
                          activityService={activityService}
                          browserApi={browserApi}
                          contributions={contributions}
                          fileOpenRequest={
                            fileOpenRequestTabIdRef.current === tab.id
                              ? fileOpenRequest
                              : null
                          }
                          instanceId={tab.id}
                          issueManagerOpenRequest={
                            issueManagerOpenRequestTabIdRef.current === tab.id
                              ? issueManagerOpenRequest
                              : null
                          }
                          i18n={i18n}
                          locale={locale}
                          messageCenterOpen={
                            activeTabId === tab.id && tab.panel === "messages"
                          }
                          onCloseMessageCenter={closePanel}
                          onAppendBrowserElementMention={
                            onAppendBrowserElementMention
                          }
                          onBrowserElementError={onBrowserElementError}
                          onOpenMessageCenterChat={onOpenMessageCenterChat}
                          setToolHost={toolHostGroup.setHost}
                          tab={tab}
                          workspaceId={workspaceId}
                        />
                      </div>
                    ) : activeTabId === tab.id ? (
                      <StandaloneAgentToolLoadingState
                        label={i18n.t("common.loading")}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

function ToolSidebarTabBar({
  activeTabId,
  apps,
  copy,
  locale,
  mountedTabs,
  onClosePanel,
  onOpenPanel
}: {
  activeTabId: string;
  apps: readonly WorkspaceAppCenterApp[];
  copy: ToolSidebarCopy;
  locale: ReturnType<typeof useTranslation>["locale"];
  mountedTabs: StandaloneAgentToolTab[];
  onClosePanel: (tabId: string) => void;
  onOpenPanel: (tab: StandaloneAgentToolTab) => void;
}): ReactNode {
  return (
    <div
      aria-label={copy.tool}
      className="nodrag flex h-[var(--agent-gui-workbench-header-height,44px)] min-w-0 flex-1 items-center gap-1 overflow-hidden px-2 [-webkit-app-region:no-drag]"
      data-standalone-agent-tool-tab-list="true"
      role="tablist"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {mountedTabs.map((tab) => {
          const app = tab.appId
            ? (apps.find((candidate) => candidate.appId === tab.appId) ?? null)
            : null;
          const label = resolveToolTabLabel(tab, copy, app, locale);
          return (
            <div
              className={cn(
                "group flex h-7 max-w-44 shrink-0 items-center rounded-sm overflow-hidden border text-xs text-[var(--text-tertiary)]",
                activeTabId === tab.id
                  ? "border-[var(--line-2)] bg-[var(--background-fronted)] text-[var(--text-primary)]"
                  : "border-transparent"
              )}
              key={tab.id}
            >
              <button
                aria-selected={activeTabId === tab.id}
                className="nodrag flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden px-2 text-left outline-none [-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
                data-standalone-agent-tool-tab={tab.panel}
                data-standalone-agent-tool-tab-id={tab.id}
                role="tab"
                type="button"
                onClick={() => onOpenPanel(tab)}
              >
                <ToolSidebarTabIcon app={app} tab={tab} />
                <span className="truncate">{label}</span>
              </button>
              <button
                aria-label={`${copy.close} ${label}`}
                className="nodrag mr-1 rounded p-0.5 opacity-100 hover:bg-[var(--transparency-block)] [-webkit-app-region:no-drag]"
                type="button"
                onClick={() => onClosePanel(tab.id)}
              >
                <CloseIcon aria-hidden className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function resolveToolTabId(
  tabs: readonly StandaloneAgentToolTab[],
  panel: StandaloneAgentToolPanelId
): string {
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index];
    if (tab?.panel === panel) {
      return tab.id;
    }
  }
  return createToolTabId(panel);
}

function resolveToolAppTabId(
  tabs: readonly StandaloneAgentToolTab[],
  appId: string
): string {
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index];
    if (tab?.panel === "apps" && tab.appId === appId) {
      return tab.id;
    }
  }
  return createToolTabId("apps");
}

function resolveToolTabLabel(
  tab: StandaloneAgentToolTab,
  copy: ToolSidebarCopy,
  app: WorkspaceAppCenterApp | null,
  locale: ReturnType<typeof useTranslation>["locale"]
): string {
  if (tab.appId) {
    return app ? resolveWorkspaceAppDisplayName(app, locale) : tab.appId;
  }
  return copy[tab.panel];
}

function ToolSidebarTabIcon({
  app,
  tab
}: {
  app: WorkspaceAppCenterApp | null;
  tab: StandaloneAgentToolTab;
}): ReactNode {
  if (tab.appId) {
    return app?.iconUrl ? (
      <img
        alt=""
        aria-hidden
        className="size-3.5 shrink-0 rounded-[3px] object-cover"
        src={app.iconUrl}
      />
    ) : (
      <ToolSidebarPanelIcon
        aria-hidden
        className="size-3.5 shrink-0"
        panel={tab.panel}
      />
    );
  }
  return (
    <ToolSidebarPanelIcon
      aria-hidden
      className="size-3.5 shrink-0"
      panel={tab.panel}
    />
  );
}

function createToolTabId(panel: StandaloneAgentToolPanelId): string {
  const instanceId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${panel}:${instanceId}`;
}
