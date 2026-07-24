import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { selectWorkspaceAgentConsumerCounts } from "@tutti-os/agent-activity-core";
import {
  AgentToolPanelIcon,
  AgentToolSidebar,
  type AgentToolBrowserController,
  type AgentToolPanelDefinition,
  type AgentToolPanelId,
  type AgentToolSidebarHeaderLayout,
  type AgentToolSidebarCopy,
  type AgentToolSidebarHandle,
  type AgentToolTab
} from "@tutti-os/agent-gui/workbench/tool-sidebar";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type {
  WorkbenchContribution,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import type { DesktopBrowserApi } from "@preload/types";
import type { WorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import {
  resolveWorkspaceAppDisplayName,
  useWorkspaceAppCenterService
} from "@renderer/features/workspace-app-center";
import { useTranslation } from "@renderer/i18n";
import type { StandaloneAgentIssueManagerOpenRequest } from "../services/standaloneAgentIssueManagerLaunch.ts";
import { StandaloneAgentDecisionNotifications } from "./StandaloneAgentDecisionNotifications.tsx";
import {
  StandaloneAgentToolSidebarPanel,
  type StandaloneAgentFileOpenRequest
} from "./StandaloneAgentToolSidebarPanel.tsx";
import { StandaloneAgentToolLoadingState } from "./StandaloneAgentToolLoadingState.tsx";
import { createStandaloneAgentToolHostGroup } from "./standaloneAgentToolWorkbench.ts";
import { useExternalStoreValue } from "./useExternalStoreValue.ts";

export type { StandaloneAgentFileOpenRequest } from "./StandaloneAgentToolSidebarPanel.tsx";

const browserControllerReadyTimeoutMs = 8_000;

interface StandaloneAgentToolSidebarProps {
  activityService: WorkspaceAgentActivityService;
  agentSessionId: string | null;
  appOpenId?: string | null;
  appI18n: I18nRuntime<string>;
  browserApi?: DesktopBrowserApi;
  children: ReactNode;
  contributions: readonly WorkbenchContribution[] | undefined;
  fileOpenRequest?: StandaloneAgentFileOpenRequest | null;
  issueManagerOpenRequest?: StandaloneAgentIssueManagerOpenRequest | null;
  mainContentMinWidthPx?: number;
  renderHeader: (layout: AgentToolSidebarHeaderLayout) => ReactNode;
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
  agentSessionId,
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
  const sidebarRef = useRef<AgentToolSidebarHandle>(null);
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth);
  const [activePanel, setActivePanel] = useState<AgentToolPanelId | null>(null);
  const [mountedTabs, setMountedTabs] = useState<readonly AgentToolTab[]>([]);
  const lastHandledAppOpenIdRef = useRef<string | null>(null);
  const lastHandledFileOpenRequestRef = useRef<string | null>(null);
  const fileOpenRequestTabIdRef = useRef<string | null>(null);
  const lastHandledIssueManagerOpenRequestRef = useRef<string | null>(null);
  const issueManagerOpenRequestTabIdRef = useRef<string | null>(null);
  const toolHostGroup = useMemo(createStandaloneAgentToolHostGroup, []);
  const browserControllersRef = useRef(
    new Map<string, { controller: AgentToolBrowserController; tabId: string }>()
  );
  const browserControllerWaitersRef = useRef(
    new Map<
      string,
      Set<
        (entry: {
          controller: AgentToolBrowserController;
          tabId: string;
        }) => void
      >
    >()
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
  const automationBrowserCount = mountedTabs.filter(
    (tab) => tab.panel === "browser" && Boolean(tab.resourceId)
  ).length;
  const panels = useMemo<readonly AgentToolPanelDefinition[]>(
    () => [
      { id: "files", label: i18n.t("workspace.agentGui.toolSidebar.files") },
      {
        id: "terminal",
        label: i18n.t("workspace.agentGui.toolSidebar.terminal")
      },
      {
        id: "browser",
        label: i18n.t("workspace.agentGui.toolSidebar.browser")
      },
      { id: "tasks", label: i18n.t("workspace.agentGui.toolSidebar.tasks") },
      { id: "apps", label: i18n.t("workspace.agentGui.toolSidebar.apps") },
      {
        id: "messages",
        label: i18n.t("workspace.agentGui.toolSidebar.messages")
      }
    ],
    [i18n]
  );
  const copy = useMemo<AgentToolSidebarCopy>(
    () => ({
      close: i18n.t("workspace.agentGui.toolSidebar.close"),
      closeRightPanel: i18n.t("workspace.agentGui.toolSidebar.closeRightPanel"),
      expand: i18n.t("workspace.agentGui.toolSidebar.expandPanel"),
      newTab: i18n.t("workspace.agentGui.toolSidebar.newTab"),
      openRightPanel: i18n.t("workspace.agentGui.toolSidebar.openRightPanel"),
      resizeSidebar: i18n.t("workspace.agentGui.toolSidebar.resizeSidebar"),
      shrink: i18n.t("workspace.agentGui.toolSidebar.shrinkPanel"),
      tool: i18n.t("workspace.agentGui.toolSidebar.tool")
    }),
    [i18n]
  );

  useEffect(() => {
    const handleResize = () => setContainerWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  const handleBrowserControllerReady = useCallback(
    (
      tabId: string,
      browserAgentSessionId: string | null,
      controller: AgentToolBrowserController | null
    ) => {
      const sessionId = browserAgentSessionId?.trim() ?? "";
      if (!sessionId) return;
      const existing = browserControllersRef.current.get(sessionId);
      if (!controller) {
        if (existing?.tabId === tabId) {
          browserControllersRef.current.delete(sessionId);
        }
        return;
      }
      const entry = { controller, tabId };
      browserControllersRef.current.set(sessionId, entry);
      const waiters = browserControllerWaitersRef.current.get(sessionId);
      if (!waiters) return;
      browserControllerWaitersRef.current.delete(sessionId);
      for (const resolve of waiters) resolve(entry);
    },
    []
  );

  useEffect(() => {
    onToolHostReady(toolHostGroup.host);
    if (!browserApi) return () => onToolHostReady(null);
    const waitForController = (
      sessionId: string
    ): Promise<{
      controller: AgentToolBrowserController;
      tabId: string;
    }> => {
      const existing = browserControllersRef.current.get(sessionId);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiters =
          browserControllerWaitersRef.current.get(sessionId) ?? new Set();
        const handleReady = (entry: {
          controller: AgentToolBrowserController;
          tabId: string;
        }) => {
          clearTimeout(timeout);
          resolve(entry);
        };
        const timeout = setTimeout(() => {
          waiters.delete(handleReady);
          if (waiters.size === 0) {
            browserControllerWaitersRef.current.delete(sessionId);
          }
          reject(new Error("Agent Browser surface did not become ready"));
        }, browserControllerReadyTimeoutMs);
        waiters.add(handleReady);
        browserControllerWaitersRef.current.set(sessionId, waiters);
      });
    };
    const disconnectAutomation = browserApi.onAutomationRequest((request) => {
      if (
        request.workspaceId !== workspaceId ||
        request.surfaceRole !== "agent"
      ) {
        return;
      }
      void (async () => {
        try {
          const sessionId = request.agentSessionId?.trim() ?? "";
          if (!sessionId) {
            throw new Error("Agent Browser request requires an agent session");
          }
          if (request.action === "create") {
            sidebarRef.current?.ensurePanel("browser", sessionId);
          }
          const entry = await waitForController(sessionId);
          if (request.action === "create") {
            const nodeId = entry.controller.createPage(request.url);
            browserApi.respondAutomationRequest({
              nodeId,
              ok: true,
              requestId: request.requestId
            });
            return;
          }
          const nodeId = request.nodeId?.trim() ?? "";
          if (!nodeId) throw new Error("Browser page id is required");
          if (request.action === "select") {
            if (!entry.controller.selectPage(nodeId)) {
              throw new Error(`Agent Browser page is unavailable: ${nodeId}`);
            }
          } else {
            const result = entry.controller.closePage(nodeId);
            if (result === "not-found") {
              throw new Error(`Agent Browser page is unavailable: ${nodeId}`);
            }
            if (result === "last-page") {
              sidebarRef.current?.closeTab(entry.tabId);
            }
          }
          browserApi.respondAutomationRequest({
            nodeId,
            ok: true,
            requestId: request.requestId
          });
        } catch (error) {
          browserApi.respondAutomationRequest({
            error: error instanceof Error ? error.message : String(error),
            ok: false,
            requestId: request.requestId
          });
        }
      })();
    });
    browserApi.announceAutomationHostReady?.({
      surfaceRole: "agent",
      workspaceId
    });
    return () => {
      disconnectAutomation();
      onToolHostReady(null);
    };
  }, [browserApi, onToolHostReady, toolHostGroup, workspaceId]);

  useEffect(() => {
    const appId = appOpenId?.trim() || null;
    if (!appId) {
      lastHandledAppOpenIdRef.current = null;
      return;
    }
    if (lastHandledAppOpenIdRef.current === appId) return;
    lastHandledAppOpenIdRef.current = appId;
    sidebarRef.current?.openPanel("apps", appId);
  }, [appOpenId]);
  useEffect(() => {
    if (
      !fileOpenRequest ||
      lastHandledFileOpenRequestRef.current === fileOpenRequest.requestID
    ) {
      return;
    }
    lastHandledFileOpenRequestRef.current = fileOpenRequest.requestID;
    fileOpenRequestTabIdRef.current =
      sidebarRef.current?.openPanel("files") ?? null;
  }, [fileOpenRequest]);
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
    issueManagerOpenRequestTabIdRef.current =
      sidebarRef.current?.openPanel("tasks") ?? null;
  }, [issueManagerOpenRequest]);
  useEffect(() => {
    if (appCenterState.catalogStatus !== "ready") return;
    const availableAppIds = new Set(
      appCenterState.apps.map((app) => app.appId)
    );
    for (const tab of mountedTabs) {
      if (
        tab.panel === "apps" &&
        tab.resourceId &&
        !availableAppIds.has(tab.resourceId)
      ) {
        sidebarRef.current?.closeTab(tab.id);
      }
    }
  }, [appCenterState.apps, appCenterState.catalogStatus, mountedTabs]);

  const handlePanelOpen = useCallback(
    (panel: AgentToolPanelId) => {
      if (panel === "apps") onAppsOpen();
    },
    [onAppsOpen]
  );
  const handleTabClose = useCallback(
    (tab: AgentToolTab) => {
      if (tab.panel !== "apps" || !tab.resourceId) return;
      if (lastHandledAppOpenIdRef.current === tab.resourceId) {
        lastHandledAppOpenIdRef.current = null;
      }
      if (
        appCenterService.getViewState(workspaceId).openAppId === tab.resourceId
      ) {
        appCenterService.setViewState({
          state: { openAppId: null },
          workspaceId
        });
      }
    },
    [appCenterService, workspaceId]
  );
  const resolveTabLabel = useCallback(
    (tab: AgentToolTab, defaultLabel: string) => {
      if (tab.panel !== "apps" || !tab.resourceId) return defaultLabel;
      const app = appCenterState.apps.find(
        (candidate) => candidate.appId === tab.resourceId
      );
      return app ? resolveWorkspaceAppDisplayName(app, locale) : tab.resourceId;
    },
    [appCenterState.apps, locale]
  );
  const renderTabIcon = useCallback(
    (tab: AgentToolTab): ReactNode => {
      if (tab.panel === "apps" && tab.resourceId) {
        const app = appCenterState.apps.find(
          (candidate) => candidate.appId === tab.resourceId
        );
        if (app?.iconUrl) {
          return (
            <img
              alt=""
              aria-hidden
              className="size-3.5 shrink-0 rounded-[3px] object-cover"
              src={app.iconUrl}
            />
          );
        }
      }
      return (
        <AgentToolPanelIcon
          aria-hidden
          className="size-3.5 shrink-0"
          panel={tab.panel}
        />
      );
    },
    [appCenterState.apps]
  );

  return (
    <>
      <StandaloneAgentDecisionNotifications
        activityService={activityService}
        i18n={i18n}
        messageCenterOpen={activePanel === "messages"}
        workspaceId={workspaceId}
      />
      <AgentToolSidebar
        ref={sidebarRef}
        containerWidth={containerWidth}
        copy={copy}
        header={{
          layout: "overlay",
          owner: "window",
          render: renderHeader
        }}
        mainContentMinWidthPx={mainContentMinWidthPx}
        panels={panels}
        quickActionPanels={[
          ...(automationBrowserCount > 0 ? (["browser"] as const) : []),
          "tasks",
          "apps",
          "messages"
        ]}
        reminders={{
          browser: automationBrowserCount,
          messages: messageCenterWorkingCount
        }}
        renderLoading={() => (
          <StandaloneAgentToolLoadingState label={i18n.t("common.loading")} />
        )}
        renderPanel={({ active, closeSidebar, tab }) => (
          <StandaloneAgentToolSidebarPanel
            active={active}
            agentSessionId={agentSessionId}
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
            messageCenterOpen={active && tab.panel === "messages"}
            setToolHost={toolHostGroup.setHost}
            tab={tab}
            workspaceId={workspaceId}
            onAppendBrowserElementMention={onAppendBrowserElementMention}
            onBrowserElementError={onBrowserElementError}
            onBrowserControllerReady={handleBrowserControllerReady}
            onCloseMessageCenter={closeSidebar}
            onOpenMessageCenterChat={onOpenMessageCenterChat}
          />
        )}
        renderTabIcon={renderTabIcon}
        resolveTabLabel={resolveTabLabel}
        resizeContainerContentWidth={resizeWindowContentWidth}
        onActivePanelChange={setActivePanel}
        onPanelOpen={handlePanelOpen}
        onTabClose={handleTabClose}
        onTabsChange={setMountedTabs}
      >
        {children}
      </AgentToolSidebar>
    </>
  );
}
