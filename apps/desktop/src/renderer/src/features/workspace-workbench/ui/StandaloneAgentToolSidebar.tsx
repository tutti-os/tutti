import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { selectWorkspaceAgentConsumerCounts } from "@tutti-os/agent-activity-core";
import type {
  WorkbenchContribution,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import {
  Button,
  CloseIcon,
  MaximizeIcon,
  RestoreIcon,
  cn
} from "@tutti-os/ui-system";
import type { WorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import type { DesktopBrowserApi } from "@preload/types";
import { useTranslation } from "@renderer/i18n";
import {
  createStandaloneAgentToolSidebarState,
  reduceStandaloneAgentToolSidebarState,
  type StandaloneAgentToolLauncherPanelId,
  type StandaloneAgentToolPanelId
} from "./standaloneAgentToolSidebarModel.ts";
import { useStandaloneAgentToolSidebarLayout } from "./useStandaloneAgentToolSidebarLayout.ts";
import {
  StandaloneAgentToolSidebarToolbar,
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
import { StandaloneAgentTerminalPanel } from "./StandaloneAgentTerminalPanel.tsx";

export type { StandaloneAgentFileOpenRequest } from "./StandaloneAgentToolSidebarPanel.tsx";
const standaloneAgentToolPanelContentMountDelayMs = 260;

interface StandaloneAgentToolSidebarProps {
  activityService: WorkspaceAgentActivityService;
  appOpenId?: string | null;
  appI18n: I18nRuntime<string>;
  browserApi?: DesktopBrowserApi;
  children: ReactNode;
  contributions: readonly WorkbenchContribution[] | undefined;
  fileOpenRequest?: StandaloneAgentFileOpenRequest | null;
  mainContentMinWidthPx?: number;
  renderHeader: (toolActions: ReactNode) => ReactNode;
  onOpenMessageCenterChat: (input: {
    agentSessionId: string;
    provider: string;
  }) => void;
  onAppsOpen: () => void;
  onToolHostReady: (host: WorkbenchHostHandle | null) => void;
  resizeWindowContentWidth: (width: number) => Promise<{ width: number }>;
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
  mainContentMinWidthPx,
  renderHeader,
  onOpenMessageCenterChat,
  onAppsOpen,
  onToolHostReady,
  resizeWindowContentWidth,
  workspaceId
}: StandaloneAgentToolSidebarProps): ReactNode {
  const { i18n, locale } = useTranslation();
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
      expand: i18n.t("workspace.agentGui.toolSidebar.expandPanel"),
      files: i18n.t("workspace.agentGui.toolSidebar.files"),
      messages: i18n.t("workspace.agentGui.toolSidebar.messages"),
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
  const [contentReadyPanels, setContentReadyPanels] = useState<
    StandaloneAgentToolPanelId[]
  >([]);
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
    stopResizing,
    togglePanelExpansion
  } = useStandaloneAgentToolSidebarLayout({
    activePanel,
    mainContentMinWidthPx,
    resizeWindowContentWidth
  });
  const resizeAnimationFrameRef = useRef<number | null>(null);
  const scheduleResizeForPanel = useCallback(
    (panel: StandaloneAgentToolPanelId | null) => {
      if (resizeAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeAnimationFrameRef.current);
      }
      resizeAnimationFrameRef.current = window.requestAnimationFrame(() => {
        resizeAnimationFrameRef.current = null;
        void resizeForPanel(panel);
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
  useEffect(() => {
    if (!activePanel || contentReadyPanels.includes(activePanel)) {
      return;
    }
    const delay = window.matchMedia?.("(prefers-reduced-motion: reduce)")
      .matches
      ? 0
      : standaloneAgentToolPanelContentMountDelayMs;
    const timer = window.setTimeout(() => {
      setContentReadyPanels((current) =>
        current.includes(activePanel) ? current : [...current, activePanel]
      );
    }, delay);
    return () => window.clearTimeout(timer);
  }, [activePanel, contentReadyPanels]);
  const lastHandledAppOpenIdRef = useRef<string | null>(null);
  const lastHandledFileOpenRequestRef = useRef<string | null>(null);
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
    dispatch({ panel: "apps", type: "open-panel" });
    scheduleResizeForPanel("apps");
  }, [appOpenId, onAppsOpen, scheduleResizeForPanel]);
  useEffect(() => {
    if (
      !fileOpenRequest ||
      lastHandledFileOpenRequestRef.current === fileOpenRequest.requestID
    ) {
      return;
    }
    lastHandledFileOpenRequestRef.current = fileOpenRequest.requestID;
    dispatch({ panel: "files", type: "open-panel" });
    scheduleResizeForPanel("files");
  }, [fileOpenRequest, scheduleResizeForPanel]);
  const closePanel = useCallback(() => {
    dispatch({ type: "close" });
    scheduleResizeForPanel(null);
  }, [scheduleResizeForPanel]);
  const selectTool = useCallback(
    (panel: StandaloneAgentToolLauncherPanelId) => {
      if (panel === "terminal") {
        dispatch({ panel, type: "select-tool" });
        return;
      }
      dispatch({ panel, type: "select-tool" });
      scheduleResizeForPanel(panel);
    },
    [scheduleResizeForPanel]
  );
  const togglePanel = useCallback(
    (panel: Exclude<StandaloneAgentToolPanelId, "browser">) => {
      const nextPanel = activePanel === panel ? null : panel;
      if (nextPanel === "apps") {
        onAppsOpen();
      }
      dispatch({ panel, type: "toggle-panel" });
      scheduleResizeForPanel(nextPanel);
    },
    [activePanel, onAppsOpen, scheduleResizeForPanel]
  );

  return (
    <>
      <div className="workbench-window__header workbench-window__header--custom">
        {renderHeader(
          <StandaloneAgentToolSidebarToolbar
            activePanel={activePanel}
            copy={copy}
            reminders={reminders}
            terminalOpen={state.terminalOpen}
            onSelectTool={selectTool}
            onTogglePanel={togglePanel}
          />
        )}
      </div>
      <div className="workbench-window__body flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="h-full min-w-0 flex-1 overflow-hidden">
            {children}
          </div>
          <aside
            aria-hidden={activePanel === null}
            className={cn(
              "relative h-full min-h-0 shrink-0 overflow-hidden transition-[width] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none",
              activePanel !== null && "border-l border-[var(--border-1)]",
              activePanel === null && "pointer-events-none"
            )}
            data-standalone-agent-tool-sidebar="true"
            style={{
              width: activePanel ? `${activePanelLayoutWidth}px` : "0px",
              zIndex: "var(--z-panel)"
            }}
          >
            <div
              className={cn(
                "absolute inset-y-0 right-0 flex flex-col bg-[var(--background-fronted)]",
                activePanel === null && "invisible"
              )}
              style={{ width: `${activePanelWidth}px` } as CSSProperties}
            >
              {activePanel ? (
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
              {activePanel ? (
                <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--border-1)] px-3">
                  <h2 className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
                    {copy[activePanel]}
                  </h2>
                  <div className="flex items-center gap-1">
                    <Button
                      aria-label={`${isActivePanelExpanded ? copy.shrink : copy.expand} ${copy[activePanel]}`}
                      aria-pressed={isActivePanelExpanded}
                      size="icon-sm"
                      title={`${isActivePanelExpanded ? copy.shrink : copy.expand} ${copy[activePanel]}`}
                      type="button"
                      variant="chrome"
                      onClick={() => togglePanelExpansion(activePanel)}
                    >
                      {isActivePanelExpanded ? (
                        <RestoreIcon aria-hidden className="size-3.5" />
                      ) : (
                        <MaximizeIcon aria-hidden className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      aria-label={`${copy.close} ${copy[activePanel]}`}
                      size="icon-sm"
                      title={`${copy.close} ${copy[activePanel]}`}
                      type="button"
                      variant="chrome"
                      onClick={closePanel}
                    >
                      <CloseIcon aria-hidden className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ) : null}
              <div className="relative min-h-0 flex-1 overflow-hidden">
                {state.mountedPanels.map((panel) => (
                  <div
                    aria-hidden={activePanel !== panel}
                    className={cn(
                      "absolute inset-0 min-h-0 overflow-hidden",
                      activePanel !== panel && "invisible pointer-events-none"
                    )}
                    key={panel}
                  >
                    {contentReadyPanels.includes(panel) ? (
                      <div className="h-full min-h-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-reduce:animate-none">
                        <StandaloneAgentToolSidebarPanel
                          active={activePanel === panel}
                          appI18n={appI18n}
                          activityService={activityService}
                          browserApi={browserApi}
                          contributions={contributions}
                          fileOpenRequest={fileOpenRequest}
                          i18n={i18n}
                          locale={locale}
                          messageCenterOpen={activePanel === "messages"}
                          onCloseMessageCenter={closePanel}
                          onOpenMessageCenterChat={onOpenMessageCenterChat}
                          panel={panel}
                          workspaceId={workspaceId}
                        />
                      </div>
                    ) : activePanel === panel ? (
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
        {state.terminalMounted ? (
          <StandaloneAgentTerminalPanel
            closeLabel={`${copy.close} ${copy.terminal}`}
            contributions={contributions}
            loadingLabel={i18n.t("common.loading")}
            onClose={() => dispatch({ type: "toggle-terminal" })}
            open={state.terminalOpen}
            setToolHost={toolHostGroup.setHost}
            unavailableLabel={copy.unavailable}
          />
        ) : null}
      </div>
    </>
  );
}
