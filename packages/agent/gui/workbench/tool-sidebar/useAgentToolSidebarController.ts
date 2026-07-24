import {
  useCallback,
  useReducer,
  useRef,
  useState,
  type TransitionEvent
} from "react";
import {
  agentToolEmptySidebarWidth,
  createAgentToolSidebarState,
  reduceAgentToolSidebarState,
  type AgentToolPanelDefinition,
  type AgentToolPanelId,
  type AgentToolTab
} from "./model.ts";
import { useAgentToolSidebarLayout } from "./useAgentToolSidebarLayout.ts";

const collapsedToolActionsWidthPx = 132;

export function useAgentToolSidebarController({
  containerWidth,
  mainContentMinWidthPx,
  panels,
  resizeContainerContentWidth,
  onActivePanelChange,
  onLayoutWidthChange,
  onPanelOpen,
  onTabsChange,
  onTabClose
}: {
  containerWidth: number;
  mainContentMinWidthPx?: number;
  panels: readonly AgentToolPanelDefinition[];
  resizeContainerContentWidth(
    width: number,
    animate?: boolean
  ): Promise<{ width: number }>;
  onActivePanelChange?: (panel: AgentToolPanelId | null) => void;
  onLayoutWidthChange?: (width: number) => void;
  onPanelOpen?: (panel: AgentToolPanelId, resourceId?: string) => void;
  onTabsChange?: (tabs: readonly AgentToolTab[]) => void;
  onTabClose?: (tab: AgentToolTab) => void;
}) {
  const panelIds = new Set(panels.map((panel) => panel.id));
  const [state, dispatch] = useReducer(
    reduceAgentToolSidebarState,
    undefined,
    createAgentToolSidebarState
  );
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isEmptySidebarClosing, setIsEmptySidebarClosing] = useState(false);
  const [contentReadyTabIds, setContentReadyTabIds] = useState<string[]>([]);
  const [toolActionsWidth, setToolActionsWidth] = useState(
    collapsedToolActionsWidthPx
  );
  const activePanel = state.activePanel;
  const activeTabId = state.activeTabId;
  const fallbackPanel = panels[0]?.id ?? null;
  const isEmptySidebar = isSidebarOpen && state.mountedTabs.length === 0;
  const isEmptySidebarSurface =
    (isSidebarOpen || isEmptySidebarClosing) && state.mountedTabs.length === 0;
  const layoutPanel =
    activePanel ?? (isEmptySidebarSurface ? fallbackPanel : null);
  const isActivePanelContentReady =
    activeTabId !== null && contentReadyTabIds.includes(activeTabId);
  const shouldAnimateSidebarLayout =
    state.mountedTabs.length === 0 || isActivePanelContentReady;
  const shouldAnimateSidebarWidth = isEmptySidebarSurface;
  const layout = useAgentToolSidebarLayout({
    activePanel: layoutPanel,
    activePanelPreferredWidth: isEmptySidebarSurface
      ? agentToolEmptySidebarWidth
      : undefined,
    containerWidth,
    mainContentMinWidthPx,
    resizeContainerContentWidth
  });
  const resizeAnimationFrameRef = useRef<number | null>(null);
  const contentAnimationFrameIdsRef = useRef(new Set<number>());
  const toolActionsResizeObserverRef = useRef<ResizeObserver | null>(null);

  const scheduleResizeForPanel = useCallback(
    (
      panel: AgentToolPanelId | null,
      preferredWidth?: number,
      options?: { animateContainer?: boolean; preserveBaseline?: boolean }
    ) => {
      if (resizeAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeAnimationFrameRef.current);
      }
      resizeAnimationFrameRef.current = window.requestAnimationFrame(() => {
        resizeAnimationFrameRef.current = null;
        void layout.resizeForPanel(panel, preferredWidth, options);
      });
    },
    [layout.resizeForPanel]
  );

  const showSidebar = useCallback(() => {
    setIsEmptySidebarClosing(false);
    setIsSidebarOpen(true);
  }, []);

  const collapseSidebarForContainerConstraint = useCallback(() => {
    setIsEmptySidebarClosing(false);
    setIsSidebarOpen(false);
    dispatch({ type: "close" });
    onActivePanelChange?.(null);
    layout.resetPanelExpansion(null);
    layout.resetContainerResizeBaseline();
  }, [
    layout.resetContainerResizeBaseline,
    layout.resetPanelExpansion,
    onActivePanelChange
  ]);

  const markContentReady = useCallback((tabId: string) => {
    if (prefersReducedMotion()) {
      setContentReadyTabIds((current) =>
        current.includes(tabId) ? current : [...current, tabId]
      );
      return;
    }
    let completedSynchronously = false;
    let frameId = 0;
    frameId = window.requestAnimationFrame(() => {
      completedSynchronously = true;
      contentAnimationFrameIdsRef.current.delete(frameId);
      setContentReadyTabIds((current) =>
        current.includes(tabId) ? current : [...current, tabId]
      );
    });
    if (!completedSynchronously) {
      contentAnimationFrameIdsRef.current.add(frameId);
    }
  }, []);

  const closePanel = useCallback(() => {
    setIsSidebarOpen(false);
    dispatch({ type: "close" });
    onActivePanelChange?.(null);
    if (state.mountedTabs.length > 0 || prefersReducedMotion()) {
      setIsEmptySidebarClosing(false);
      scheduleResizeForPanel(null);
      return;
    }
    setIsEmptySidebarClosing(true);
    scheduleResizeForPanel(null, undefined, {
      animateContainer: true,
      preserveBaseline: true
    });
  }, [onActivePanelChange, scheduleResizeForPanel, state.mountedTabs.length]);

  const openPanel = useCallback(
    (panel: AgentToolPanelId, resourceId?: string) => {
      if (!panelIds.has(panel)) return null;
      showSidebar();
      onPanelOpen?.(panel, resourceId);
      const tabId = resolveToolTabId(state.mountedTabs, panel, resourceId);
      const action = { panel, resourceId, tabId, type: "open-panel" } as const;
      const nextState = reduceAgentToolSidebarState(state, action);
      dispatch(action);
      onActivePanelChange?.(panel);
      if (nextState.mountedTabs !== state.mountedTabs) {
        onTabsChange?.(nextState.mountedTabs);
      }
      markContentReady(tabId);
      scheduleResizeForPanel(panel);
      return tabId;
    },
    [
      markContentReady,
      onActivePanelChange,
      onPanelOpen,
      onTabsChange,
      panelIds,
      scheduleResizeForPanel,
      showSidebar,
      state
    ]
  );

  const addPanel = useCallback(
    (panel: AgentToolPanelId, resourceId?: string) => {
      if (!panelIds.has(panel)) return null;
      showSidebar();
      onPanelOpen?.(panel, resourceId);
      const tabId = createToolTabId(panel);
      const action = { panel, resourceId, tabId, type: "add-panel" } as const;
      const nextState = reduceAgentToolSidebarState(state, action);
      dispatch(action);
      onActivePanelChange?.(panel);
      onTabsChange?.(nextState.mountedTabs);
      markContentReady(tabId);
      scheduleResizeForPanel(panel);
      return tabId;
    },
    [
      markContentReady,
      onActivePanelChange,
      onPanelOpen,
      onTabsChange,
      panelIds,
      scheduleResizeForPanel,
      showSidebar,
      state
    ]
  );

  const ensurePanel = useCallback(
    (panel: AgentToolPanelId, resourceId?: string) => {
      if (!panelIds.has(panel)) return null;
      const existing = state.mountedTabs.find(
        (tab) =>
          tab.panel === panel && (tab.resourceId ?? undefined) === resourceId
      );
      if (existing) return existing.id;
      const tabId = createToolTabId(panel);
      const action = {
        panel,
        resourceId,
        tabId,
        type: "ensure-panel"
      } as const;
      const nextState = reduceAgentToolSidebarState(state, action);
      dispatch(action);
      onTabsChange?.(nextState.mountedTabs);
      markContentReady(tabId);
      return tabId;
    },
    [markContentReady, onTabsChange, panelIds, state]
  );

  const closePanelTab = useCallback(
    (tabId: string) => {
      const closingIndex = state.mountedTabs.findIndex(
        (tab) => tab.id === tabId
      );
      const closingTab = state.mountedTabs[closingIndex];
      if (!closingTab) return;
      const action = { tabId, type: "close-tab" } as const;
      const nextState = reduceAgentToolSidebarState(state, action);
      setIsSidebarOpen(true);
      dispatch(action);
      onTabClose?.(closingTab);
      onActivePanelChange?.(nextState.activePanel);
      onTabsChange?.(nextState.mountedTabs);
      if (nextState.activePanel === null) {
        if (fallbackPanel) {
          scheduleResizeForPanel(fallbackPanel, agentToolEmptySidebarWidth, {
            animateContainer: !prefersReducedMotion()
          });
        }
        return;
      }
      scheduleResizeForPanel(nextState.activePanel);
    },
    [
      fallbackPanel,
      onActivePanelChange,
      onTabClose,
      onTabsChange,
      scheduleResizeForPanel,
      state
    ]
  );

  const activatePanelTab = useCallback(
    (tab: AgentToolTab) => {
      onPanelOpen?.(tab.panel, tab.resourceId);
      dispatch({ tabId: tab.id, type: "activate-tab" });
      onActivePanelChange?.(tab.panel);
      markContentReady(tab.id);
      scheduleResizeForPanel(tab.panel);
    },
    [markContentReady, onActivePanelChange, onPanelOpen, scheduleResizeForPanel]
  );

  const toggleSidebar = useCallback(() => {
    const nextPanel = activePanel ?? fallbackPanel;
    if (isSidebarOpen) {
      closePanel();
      return;
    }
    if (!nextPanel) return;
    showSidebar();
    if (state.mountedTabs.length === 0) {
      scheduleResizeForPanel(nextPanel, agentToolEmptySidebarWidth, {
        animateContainer: !prefersReducedMotion()
      });
      return;
    }
    const tabId = resolveToolTabId(state.mountedTabs, nextPanel);
    dispatch({ panel: nextPanel, tabId, type: "open-panel" });
    onActivePanelChange?.(nextPanel);
    markContentReady(tabId);
    scheduleResizeForPanel(nextPanel);
  }, [
    activePanel,
    closePanel,
    fallbackPanel,
    isSidebarOpen,
    markContentReady,
    onActivePanelChange,
    scheduleResizeForPanel,
    showSidebar,
    state.mountedTabs
  ]);

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
      layout.resetContainerResizeBaseline();
    },
    [isEmptySidebarClosing, isSidebarOpen, layout.resetContainerResizeBaseline]
  );

  const bindLayoutWidthProjection = useCallback(
    (node: HTMLElement | null) => {
      if (node) {
        onLayoutWidthChange?.(
          isSidebarOpen ? layout.activePanelLayoutWidth : 0
        );
      }
    },
    [isSidebarOpen, layout.activePanelLayoutWidth, onLayoutWidthChange]
  );

  const bindLifecycle = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) return;
      if (resizeAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeAnimationFrameRef.current);
        resizeAnimationFrameRef.current = null;
      }
      for (const frameId of contentAnimationFrameIdsRef.current) {
        window.cancelAnimationFrame(frameId);
      }
      contentAnimationFrameIdsRef.current.clear();
      toolActionsResizeObserverRef.current?.disconnect();
      toolActionsResizeObserverRef.current = null;
      layout.bindLayoutRoot(null);
    },
    [layout.bindLayoutRoot]
  );

  const measureToolActions = useCallback((node: HTMLDivElement | null) => {
    toolActionsResizeObserverRef.current?.disconnect();
    toolActionsResizeObserverRef.current = null;
    if (!node) return;
    const measure = (): void => {
      const width = Math.ceil(node.getBoundingClientRect().width);
      if (width > 0) setToolActionsWidth(width);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    toolActionsResizeObserverRef.current = observer;
  }, []);

  return {
    ...layout,
    activePanel,
    activeTabId,
    activatePanelTab,
    addPanel,
    bindLayoutWidthProjection,
    bindLifecycle,
    closePanel,
    collapseSidebarForContainerConstraint,
    closePanelTab,
    contentReadyTabIds,
    ensurePanel,
    handleSidebarTransitionEnd,
    isEmptySidebar,
    isEmptySidebarClosing,
    isSidebarOpen,
    markContentReady,
    measureToolActions,
    mountedTabs: state.mountedTabs,
    openPanel,
    shouldAnimateSidebarLayout,
    shouldAnimateSidebarWidth,
    toolActionsWidth,
    toggleSidebar
  };
}

function resolveToolTabId(
  tabs: readonly AgentToolTab[],
  panel: AgentToolPanelId,
  resourceId?: string
): string {
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index];
    if (
      tab?.panel === panel &&
      (resourceId === undefined || tab.resourceId === resourceId)
    ) {
      return tab.id;
    }
  }
  return createToolTabId(panel);
}

function createToolTabId(panel: AgentToolPanelId): string {
  const instanceId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${panel}:${instanceId}`;
}

function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}
