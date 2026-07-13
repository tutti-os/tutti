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
import {
  buildWorkspaceAgentMessageCenterModelFromEngine,
  selectWorkspaceAgentMessageCenterPresentation,
  stabilizeWorkspaceAgentMessageCenterModel,
  workspaceAgentMessageCenterPromptStatus,
  WorkspaceAgentMessageCenterPanel,
  dispatchAgentPlanPromptAction,
  useEngineSelector,
  type WorkspaceAgentMessageCenterModel,
  type WorkspaceAgentMessageCenterPresentation
} from "@tutti-os/agent-gui/agent-message-center";
import { selectEnginePendingInteractions } from "@tutti-os/agent-activity-core";
import { BrowserNode } from "@tutti-os/browser-node/react";
import type { BrowserNodeI18nKey } from "@tutti-os/browser-node/i18n";
import { TerminalNode } from "@tutti-os/workspace-terminal/react";
import type { TerminalTheme } from "@tutti-os/workspace-terminal/contracts";
import type { TerminalNodeI18nKey } from "@tutti-os/workspace-terminal/i18n";
import type {
  WorkbenchContribution,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import { CloseIcon, cn } from "@tutti-os/ui-system";
import { WorkspaceFileManagerPane } from "@renderer/features/workspace-file-manager";
import type { WorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import type { DesktopBrowserApi } from "@preload/types";
import { useTranslation } from "@renderer/i18n";
import { getWorkspaceTerminalSurfaceRuntime } from "../services/workspaceTerminalSurfaceRuntime.ts";
import {
  createStandaloneAgentToolSidebarState,
  reduceStandaloneAgentToolSidebarState,
  type StandaloneAgentSharedToolPanelId,
  type StandaloneAgentToolPanelId
} from "./standaloneAgentToolSidebarModel.ts";
import { useStandaloneAgentToolSidebarLayout } from "./useStandaloneAgentToolSidebarLayout.ts";
import {
  StandaloneAgentToolSidebarToolbar,
  ToolSidebarPanelIcon,
  type ToolSidebarCopy,
  type ToolSidebarReminderCounts
} from "./StandaloneAgentToolSidebarToolbar.tsx";
import {
  createStandaloneAgentDirectToolHost,
  createStandaloneAgentToolHostGroup,
  createStandaloneAgentBrowserToolFeature
} from "./standaloneAgentToolWorkbench.ts";
import { standaloneAgentBrowserDefaultUrl } from "./standaloneAgentToolWorkbench.ts";
import { StandaloneAgentAppCenterToolPanel } from "./StandaloneAgentAppCenterToolPanel.tsx";
import { useExternalStoreValue } from "./useExternalStoreValue.ts";

const browserNodeLoadFailedI18nKey: BrowserNodeI18nKey = "loadFailed";
const terminalCloseGuardDescriptionI18nKey: TerminalNodeI18nKey =
  "closeGuard.description";
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
  onToolHostReady: (host: WorkbenchHostHandle | null) => void;
  resizeWindowContentWidth: (width: number) => Promise<{ width: number }>;
  workspaceId: string;
}

export interface StandaloneAgentFileOpenRequest {
  path: string;
  requestID: string;
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
  const activitySnapshot = useExternalStoreValue(
    (listener) => activityService.subscribe(workspaceId, listener),
    () => activityService.getSnapshot(workspaceId),
    () => activityService.getSnapshot(workspaceId)
  );
  const sessionEngine = useMemo(
    () => activityService.getSessionEngine(workspaceId),
    [activityService, workspaceId]
  );
  const messageCenterPresentation = useEngineSelector(
    sessionEngine,
    selectWorkspaceAgentMessageCenterPresentation
  );
  const messageCenterModelRef = useRef<WorkspaceAgentMessageCenterModel | null>(
    null
  );
  const messageCenterItemCutoffUnixMs = useMemo(
    () => Date.now() - 7 * 24 * 60 * 60 * 1000,
    [workspaceId]
  );
  const messageCenterModel = useMemo(() => {
    const nextModel = buildWorkspaceAgentMessageCenterModelFromEngine(
      messageCenterPresentation,
      activitySnapshot,
      {
        itemCutoffUnixMs: messageCenterItemCutoffUnixMs,
        promptFallbackLabels: {
          constraintHeader: i18n.t(
            "workspace.agentMessageCenter.promptConstraintHeader"
          ),
          inputHeader: i18n.t("workspace.agentMessageCenter.promptInputHeader"),
          question: i18n.t("workspace.agentMessageCenter.promptQuestion"),
          title: i18n.t("workspace.agentMessageCenter.promptTitle")
        },
        workspaceRoot: null
      }
    );
    const stableModel = stabilizeWorkspaceAgentMessageCenterModel(
      messageCenterModelRef.current,
      nextModel
    );
    messageCenterModelRef.current = stableModel;
    return stableModel;
  }, [
    activitySnapshot,
    i18n,
    messageCenterItemCutoffUnixMs,
    messageCenterPresentation
  ]);
  const copy = useMemo<ToolSidebarCopy>(
    () => ({
      apps: i18n.t("workspace.agentGui.toolSidebar.apps"),
      browser: i18n.t("workspace.agentGui.toolSidebar.browser"),
      close: i18n.t("workspace.agentGui.toolSidebar.close"),
      closeRightPanel: i18n.t("workspace.agentGui.toolSidebar.closeRightPanel"),
      expand: i18n.t("workspace.agentGui.toolSidebar.expandPanel"),
      files: i18n.t("workspace.agentGui.toolSidebar.files"),
      messages: i18n.t("workspace.agentGui.toolSidebar.messages"),
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
      messages: messageCenterModel.counts.working
    }),
    [messageCenterModel.counts.working]
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
    dispatch({ panel: "apps", type: "open-panel" });
    void resizeForPanel("apps");
  }, [appOpenId, resizeForPanel]);
  useEffect(() => {
    if (
      !fileOpenRequest ||
      lastHandledFileOpenRequestRef.current === fileOpenRequest.requestID
    ) {
      return;
    }
    lastHandledFileOpenRequestRef.current = fileOpenRequest.requestID;
    dispatch({ panel: "files", type: "open-panel" });
    void resizeForPanel("files");
  }, [fileOpenRequest, resizeForPanel]);
  const closePanel = useCallback(() => {
    dispatch(
      activePanel === "terminal"
        ? { type: "toggle-terminal" }
        : { type: "close" }
    );
    void resizeForPanel(null);
  }, [activePanel, resizeForPanel]);
  const openPanel = useCallback(
    (panel: StandaloneAgentToolPanelId) => {
      dispatch({ panel, type: "open-panel" });
      void resizeForPanel(panel);
    },
    [resizeForPanel]
  );
  const toggleSidebar = useCallback(() => {
    const nextPanel = activePanel ?? "files";
    dispatch(
      activePanel === null
        ? { panel: nextPanel, type: "open-panel" }
        : { type: "close" }
    );
    void resizeForPanel(activePanel === null ? nextPanel : null);
  }, [activePanel, resizeForPanel]);
  const closePanelTab = useCallback(
    (panel: StandaloneAgentToolPanelId) => {
      const nextMountedPanels = state.mountedPanels.filter(
        (candidate) => candidate !== panel
      );
      const nextPanel =
        activePanel === panel
          ? (nextMountedPanels[nextMountedPanels.length - 1] ?? null)
          : activePanel;
      dispatch({ panel, type: "close-panel" });
      void resizeForPanel(nextPanel);
    },
    [activePanel, resizeForPanel, state.mountedPanels]
  );

  return (
    <>
      <div
        className="workbench-window__header workbench-window__header--custom"
        style={
          {
            "--agent-gui-tool-sidebar-layout-width": activePanel
              ? `${activePanelLayoutWidth}px`
              : "0px"
          } as CSSProperties
        }
      >
        {renderHeader(
          <div
            className={cn(
              "nodrag flex h-[var(--agent-gui-workbench-header-height,44px)] min-w-0 max-w-full shrink-0 items-center pr-[var(--agent-gui-workbench-header-padding-x)] [-webkit-app-region:no-drag]",
              activePanel && "border-b border-[var(--border-1)]"
            )}
            data-standalone-agent-tool-sidebar-header="true"
            style={
              activePanel
                ? {
                    width: `${activePanelWidth}px`,
                    maxWidth: "100%"
                  }
                : undefined
            }
          >
            {activePanel ? (
              <ToolSidebarTabBar
                activePanel={activePanel}
                copy={copy}
                mountedPanels={state.mountedPanels}
                onClosePanel={closePanelTab}
                onOpenPanel={openPanel}
              />
            ) : null}
            <StandaloneAgentToolSidebarToolbar
              activePanel={activePanel}
              copy={copy}
              isExpanded={isActivePanelExpanded}
              reminders={reminders}
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
            aria-hidden={activePanel === null}
            className={cn(
              "relative h-full min-h-0 shrink-0 overflow-hidden transition-[width] duration-[260ms] ease-in-out will-change-[width] motion-reduce:transition-none",
              isActivePanelExpanded && "border-l border-[var(--line-1)]",
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
                "absolute inset-y-0 right-0 flex flex-col bg-[var(--background-session-sidepanel)]",
                activePanel === null && "invisible"
              )}
              style={
                {
                  "--background-panel": "var(--background-session-sidepanel)",
                  width: `${activePanelWidth}px`
                } as CSSProperties
              }
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
                      <div
                        className={cn(
                          "h-full min-h-0",
                          panel !== "terminal" &&
                            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-reduce:animate-none"
                        )}
                      >
                        <ToolSidebarPanel
                          active={activePanel === panel}
                          appI18n={appI18n}
                          activityService={activityService}
                          activitySnapshot={activitySnapshot}
                          browserApi={browserApi}
                          contributions={contributions}
                          fileOpenRequest={fileOpenRequest}
                          i18n={i18n}
                          locale={locale}
                          messageCenterModel={messageCenterModel}
                          messageCenterPresentation={messageCenterPresentation}
                          messageCenterOpen={activePanel === "messages"}
                          onCloseMessageCenter={closePanel}
                          onOpenMessageCenterChat={onOpenMessageCenterChat}
                          panel={panel}
                          setToolHost={toolHostGroup.setHost}
                          workspaceId={workspaceId}
                        />
                      </div>
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
  activePanel,
  copy,
  mountedPanels,
  onClosePanel,
  onOpenPanel
}: {
  activePanel: StandaloneAgentToolPanelId;
  copy: ToolSidebarCopy;
  mountedPanels: StandaloneAgentToolPanelId[];
  onClosePanel: (panel: StandaloneAgentToolPanelId) => void;
  onOpenPanel: (panel: StandaloneAgentToolPanelId) => void;
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
        {mountedPanels.map((panel) => (
          <div
            className={cn(
              "group flex h-7 max-w-44 shrink-0 items-center rounded-sm overflow-hidden border text-xs text-[var(--text-tertiary)]",
              activePanel === panel
                ? "border-[var(--line-2)] bg-[var(--background-fronted)] text-[var(--text-primary)]"
                : "border-transparent"
            )}
            key={panel}
          >
            <button
              aria-selected={activePanel === panel}
              className="nodrag flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden px-2 text-left outline-none [-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
              data-standalone-agent-tool-tab={panel}
              role="tab"
              type="button"
              onClick={() => onOpenPanel(panel)}
            >
              <ToolSidebarPanelIcon
                aria-hidden
                className="size-3.5 shrink-0"
                panel={panel}
              />
              <span className="truncate">{copy[panel]}</span>
            </button>
            <button
              aria-label={`${copy.close} ${copy[panel]}`}
              className="nodrag mr-1 rounded p-0.5 opacity-100 hover:bg-[var(--transparency-block)] [-webkit-app-region:no-drag]"
              type="button"
              onClick={() => onClosePanel(panel)}
            >
              <CloseIcon aria-hidden className="size-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolSidebarPanel({
  active,
  appI18n,
  activityService,
  activitySnapshot,
  browserApi,
  contributions,
  fileOpenRequest,
  i18n,
  locale,
  messageCenterModel,
  messageCenterPresentation,
  messageCenterOpen,
  onCloseMessageCenter,
  onOpenMessageCenterChat,
  panel,
  setToolHost,
  workspaceId
}: {
  active: boolean;
  appI18n: I18nRuntime<string>;
  activityService: WorkspaceAgentActivityService;
  activitySnapshot: ReturnType<WorkspaceAgentActivityService["getSnapshot"]>;
  browserApi?: DesktopBrowserApi;
  contributions: readonly WorkbenchContribution[] | undefined;
  fileOpenRequest: StandaloneAgentFileOpenRequest | null;
  i18n: I18nRuntime<string>;
  locale: ReturnType<typeof useTranslation>["locale"];
  messageCenterModel: WorkspaceAgentMessageCenterModel;
  messageCenterPresentation: WorkspaceAgentMessageCenterPresentation;
  messageCenterOpen: boolean;
  onCloseMessageCenter: () => void;
  onOpenMessageCenterChat: (input: {
    agentSessionId: string;
    provider: string;
  }) => void;
  panel: StandaloneAgentToolPanelId;
  setToolHost: (
    typeId: StandaloneAgentSharedToolPanelId,
    host: WorkbenchHostHandle | null
  ) => void;
  workspaceId: string;
}): ReactNode {
  if (panel === "files") {
    return (
      <WorkspaceFileManagerPane
        className="h-full"
        revealIntent={fileOpenRequest}
        workspaceID={workspaceId}
      />
    );
  }
  if (panel === "apps") {
    return (
      <StandaloneAgentAppCenterToolPanel
        active={active}
        backLabel={i18n.t("workspace.appCenter.backToApps")}
        contributions={contributions}
        unavailableLabel={i18n.t("workspace.agentGui.toolSidebar.unavailable")}
        workspaceId={workspaceId}
      />
    );
  }
  if (panel === "messages") {
    return (
      <StandaloneAgentMessageCenterPanel
        activityService={activityService}
        activitySnapshot={activitySnapshot}
        i18n={i18n}
        locale={locale}
        model={messageCenterModel}
        presentationState={messageCenterPresentation}
        open={messageCenterOpen}
        workspaceId={workspaceId}
        onClose={onCloseMessageCenter}
        onOpenChat={onOpenMessageCenterChat}
      />
    );
  }
  if (panel === "browser") {
    return browserApi ? (
      <StandaloneAgentBrowserToolPanel
        appI18n={appI18n}
        browserApi={browserApi}
        hidden={!active}
      />
    ) : null;
  }
  if (panel === "terminal") {
    return (
      <StandaloneAgentTerminalPanel
        contributions={contributions}
        open={active}
        setToolHost={setToolHost}
        unavailableLabel={i18n.t("workspace.agentGui.toolSidebar.unavailable")}
      />
    );
  }
  return null;
}

function StandaloneAgentMessageCenterPanel({
  activityService,
  activitySnapshot,
  i18n,
  locale,
  model,
  presentationState,
  open,
  workspaceId,
  onClose,
  onOpenChat
}: {
  activityService: WorkspaceAgentActivityService;
  activitySnapshot: ReturnType<WorkspaceAgentActivityService["getSnapshot"]>;
  i18n: I18nRuntime<string>;
  locale: ReturnType<typeof useTranslation>["locale"];
  model: WorkspaceAgentMessageCenterModel;
  presentationState: WorkspaceAgentMessageCenterPresentation;
  open: boolean;
  workspaceId: string;
  onClose: () => void;
  onOpenChat: (input: { agentSessionId: string; provider: string }) => void;
}): ReactNode {
  const requestedSessionSummaryIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!open) {
      return;
    }
    for (const session of activitySnapshot.sessions.slice(0, 12)) {
      const agentSessionId = session.agentSessionId.trim();
      if (
        !agentSessionId ||
        requestedSessionSummaryIdsRef.current.has(agentSessionId) ||
        hasCachedSessionMessages(activitySnapshot, session)
      ) {
        continue;
      }
      requestedSessionSummaryIdsRef.current.add(agentSessionId);
      void activityService
        .listSessionMessages({
          agentSessionId,
          limit: 20,
          order: "desc",
          workspaceId
        })
        .catch(() => {
          requestedSessionSummaryIdsRef.current.delete(agentSessionId);
        });
    }
  }, [activityService, activitySnapshot, open, workspaceId]);

  const handleSubmitPrompt = useCallback(
    async (input: {
      action?: string;
      agentSessionId: string;
      optionId?: string;
      payload?: Record<string, unknown>;
      promptKind?: string;
      requestId: string;
    }) => {
      const engine = activityService.getSessionEngine(workspaceId);
      if (input.promptKind === "plan-implementation") {
        if (
          input.action === "implement" ||
          input.action === "feedback" ||
          input.action === "skip"
        ) {
          dispatchAgentPlanPromptAction({
            action: input.action,
            agentSessionId: input.agentSessionId,
            engine,
            feedbackText:
              typeof input.payload?.text === "string"
                ? input.payload.text
                : undefined,
            requestId: input.requestId,
            workspaceId
          });
        }
        return;
      }
      const interaction = selectEnginePendingInteractions(
        engine.getSnapshot(),
        input.agentSessionId
      ).find((candidate) => candidate.requestId === input.requestId);
      if (!interaction) return;
      engine.dispatch({
        type: "interaction/responseRequested",
        agentSessionId: input.agentSessionId,
        commandId: [
          workspaceId,
          input.agentSessionId,
          interaction.turnId,
          input.requestId
        ].join(":"),
        requestId: input.requestId,
        turnId: interaction.turnId,
        workspaceId,
        ...(input.action ? { action: input.action } : {}),
        ...(input.optionId ? { optionId: input.optionId } : {}),
        ...(input.payload ? { payload: input.payload } : {})
      });
    },
    [activityService, workspaceId]
  );

  const handleOpenChat = useCallback(
    (input: { agentSessionId: string; provider: string }) => {
      onOpenChat(input);
      onClose();
    },
    [onClose, onOpenChat]
  );

  return (
    <WorkspaceAgentMessageCenterPanel
      i18n={i18n}
      locale={locale}
      model={model}
      open={open}
      presentation="embedded"
      onClose={onClose}
      onOpenChat={handleOpenChat}
      promptStatus={(item) =>
        workspaceAgentMessageCenterPromptStatus(presentationState, item)
      }
      onSubmitPrompt={handleSubmitPrompt}
    />
  );
}

function hasCachedSessionMessages(
  snapshot: ReturnType<WorkspaceAgentActivityService["getSnapshot"]>,
  session: ReturnType<
    WorkspaceAgentActivityService["getSnapshot"]
  >["sessions"][number]
): boolean {
  return [session.agentSessionId, session.providerSessionId]
    .filter((value): value is string => Boolean(value?.trim()))
    .some(
      (sessionId) => (snapshot.sessionMessagesById[sessionId]?.length ?? 0) > 0
    );
}

function StandaloneAgentBrowserToolPanel({
  appI18n,
  browserApi,
  hidden
}: {
  appI18n: I18nRuntime<string>;
  browserApi: DesktopBrowserApi;
  hidden: boolean;
}): ReactNode {
  const [nodeId] = useState(createStandaloneAgentBrowserNodeId);
  const feature = useMemo(
    () =>
      createStandaloneAgentBrowserToolFeature({
        browserApi,
        i18n: appI18n,
        nodeId
      }),
    [appI18n, browserApi, nodeId]
  );
  const [activationFailed, setActivationFailed] = useState(false);
  const runtimeState = useExternalStoreValue(
    feature.runtimeStore.subscribe,
    () => feature.runtimeStore.getNodeState(nodeId),
    () => feature.runtimeStore.getNodeState(nodeId)
  );

  useEffect(() => {
    const disconnect = feature.connect();
    setActivationFailed(false);
    void browserApi
      .activate({
        navigationPolicy: null,
        nodeId,
        profileId: null,
        sessionMode: "shared",
        url: standaloneAgentBrowserDefaultUrl
      })
      .catch(() => setActivationFailed(true));
    return () => {
      disconnect();
      void browserApi.close({ nodeId }).catch(() => undefined);
    };
  }, [browserApi, feature, nodeId]);

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden"
      data-standalone-agent-browser-surface="true"
    >
      <BrowserNode
        defaultUrl={standaloneAgentBrowserDefaultUrl}
        feature={feature}
        hidden={hidden}
        nodeId={nodeId}
        syncDefaultUrl
      />
      {activationFailed && runtimeState.lifecycle === "cold" ? (
        <div
          className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-secondary)]"
          role="status"
        >
          {feature.i18n.t(browserNodeLoadFailedI18nKey)}
        </div>
      ) : null}
    </div>
  );
}

function createStandaloneAgentBrowserNodeId(): string {
  const instanceId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `browser:standalone-agent-tool:${instanceId}`;
}

function StandaloneAgentTerminalPanel({
  contributions,
  open,
  setToolHost,
  unavailableLabel
}: {
  contributions: readonly WorkbenchContribution[] | undefined;
  open: boolean;
  setToolHost: (
    panel: StandaloneAgentSharedToolPanelId,
    host: WorkbenchHostHandle | null
  ) => void;
  unavailableLabel: string;
}): ReactNode {
  const runtime = useMemo(() => {
    const contribution = contributions?.find(
      (candidate) => candidate.id === "workspace-terminal"
    );
    return contribution
      ? getWorkspaceTerminalSurfaceRuntime(contribution)
      : null;
  }, [contributions]);
  const terminalFeature = useMemo(() => {
    if (!runtime) {
      return null;
    }
    return {
      ...runtime.feature,
      resolveTheme(input: Parameters<typeof runtime.feature.resolveTheme>[0]) {
        const panelTheme = resolveStandaloneAgentTerminalTheme();
        const terminalTheme = runtime.feature.resolveTheme(input);
        return {
          ...panelTheme,
          ...terminalTheme,
          background: panelTheme.background ?? terminalTheme.background
        };
      }
    };
  }, [runtime]);
  const [nodeId] = useState(createStandaloneAgentTerminalNodeId);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState(false);
  const launchPromiseRef = useRef<Promise<void> | null>(null);
  const directHost = useMemo(createStandaloneAgentDirectToolHost, []);
  const externalState = useExternalStoreValue(
    runtime?.subscribe ?? emptySubscribe,
    () => runtime?.getExternalState(sessionId) ?? null,
    () => null
  );

  useEffect(() => {
    setToolHost("terminal", directHost.host);
    return () => setToolHost("terminal", null);
  }, [directHost, setToolHost]);

  useEffect(() => {
    directHost.setNode(
      sessionId
        ? {
            instanceId: sessionId,
            nodeId,
            resolveCloseEffect: async () => {
              const latestState = runtime?.getExternalState(sessionId) ?? null;
              if (
                !runtime ||
                !latestState ||
                latestState.status === "created" ||
                latestState.status === "exited" ||
                latestState.status === "failed"
              ) {
                return null;
              }
              try {
                const guard = await runtime.feature.closeGuard.check({
                  sessionId
                });
                if (
                  !guard.requiresConfirmation ||
                  guard.reason === "not-running" ||
                  guard.status === "exited" ||
                  guard.status === "failed"
                ) {
                  return null;
                }
              } catch {
                // Preserve the OS terminal's conservative close behavior when
                // the daemon cannot resolve the guard state.
              }
              return {
                description: runtime.feature.i18n.t(
                  terminalCloseGuardDescriptionI18nKey
                ),
                nodeId,
                title: latestState.title,
                typeId: "workspace-terminal"
              };
            },
            title: externalState?.title ?? "",
            typeId: "workspace-terminal"
          }
        : null
    );
  }, [directHost, externalState?.title, nodeId, runtime, sessionId]);

  useEffect(() => {
    if (!open || !runtime || sessionId || launchPromiseRef.current) {
      return;
    }
    setLaunchError(false);
    const launchPromise = runtime
      .createSession()
      .then((session) => setSessionId(session.sessionId))
      .catch(() => setLaunchError(true))
      .finally(() => {
        if (launchPromiseRef.current === launchPromise) {
          launchPromiseRef.current = null;
        }
      });
    launchPromiseRef.current = launchPromise;
  }, [open, runtime, sessionId]);

  return (
    <section
      aria-hidden={!open}
      className={cn(
        "relative h-full min-h-0 overflow-hidden bg-[var(--background-session-sidepanel)]",
        !open && "pointer-events-none"
      )}
      data-standalone-agent-terminal-panel="true"
      style={
        {
          "--tutti-surface": "var(--background-session-sidepanel)"
        } as CSSProperties
      }
    >
      <div
        className="h-full min-h-0 overflow-hidden"
        data-standalone-agent-terminal-surface="true"
      >
        {terminalFeature && sessionId ? (
          <TerminalNode
            externalState={externalState}
            feature={terminalFeature}
            nodeId={nodeId}
            sessionId={sessionId}
            showHeader={false}
          />
        ) : launchError || !runtime ? (
          <div
            className="flex h-full items-center justify-center text-sm text-[var(--text-secondary)]"
            role="status"
          >
            {unavailableLabel}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function createStandaloneAgentTerminalNodeId(): string {
  const instanceId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `workspace-terminal:standalone-agent-tool:${instanceId}`;
}

function resolveStandaloneAgentTerminalTheme(): TerminalTheme {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {};
  }
  const styles = window.getComputedStyle(document.documentElement);
  const background = styles
    .getPropertyValue("--background-session-sidepanel")
    .trim();
  const foreground = styles.getPropertyValue("--text-primary").trim();
  return {
    ...(background ? { background } : {}),
    ...(foreground ? { cursor: foreground, foreground } : {})
  };
}

function emptySubscribe(): () => void {
  return () => undefined;
}
