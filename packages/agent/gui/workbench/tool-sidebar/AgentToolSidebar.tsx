import {
  forwardRef,
  useImperativeHandle,
  type CSSProperties,
  type ReactNode
} from "react";
import { CloseIcon, cn } from "@tutti-os/ui-system";
import {
  filterAgentToolPanels,
  type AgentToolPanelDefinition,
  type AgentToolPanelId,
  type AgentToolTab
} from "./model.ts";
import { AgentToolSidebarPicker } from "./Picker.tsx";
import {
  AgentToolPanelIcon,
  AgentToolSidebarToolbar,
  type AgentToolSidebarCopy,
  type AgentToolSidebarReminderCounts
} from "./Toolbar.tsx";
import type {
  AgentToolSidebarHeaderContract,
  AgentToolSidebarHeaderLayout
} from "./headerLayout.ts";
import { useAgentToolSidebarController } from "./useAgentToolSidebarController.ts";

export interface AgentToolSidebarHandle {
  addPanel(panel: AgentToolPanelId, resourceId?: string): string | null;
  close(): void;
  collapseForContainerConstraint(): void;
  closeTab(tabId: string): void;
  ensurePanel(panel: AgentToolPanelId, resourceId?: string): string | null;
  openPanel(panel: AgentToolPanelId, resourceId?: string): string | null;
}

export interface AgentToolSidebarProps {
  children: ReactNode;
  containerWidth: number;
  copy: AgentToolSidebarCopy;
  header: AgentToolSidebarHeaderContract;
  mainContentMinWidthPx?: number;
  panels: readonly AgentToolPanelDefinition[];
  quickActionPanels?: readonly AgentToolPanelId[];
  reminders?: AgentToolSidebarReminderCounts;
  renderLoading?: (tab: AgentToolTab) => ReactNode;
  renderPanel: (input: {
    active: boolean;
    closeSidebar: () => void;
    tab: AgentToolTab;
  }) => ReactNode;
  renderTabIcon?: (tab: AgentToolTab) => ReactNode;
  resolveTabLabel?: (tab: AgentToolTab, defaultLabel: string) => string;
  resizeContainerContentWidth(
    width: number,
    animate?: boolean
  ): Promise<{ width: number }>;
  onPanelOpen?: (panel: AgentToolPanelId, resourceId?: string) => void;
  onLayoutWidthChange?: (width: number) => void;
  onActivePanelChange?: (panel: AgentToolPanelId | null) => void;
  onTabsChange?: (tabs: readonly AgentToolTab[]) => void;
  onTabClose?: (tab: AgentToolTab) => void;
}

export const AgentToolSidebar = forwardRef<
  AgentToolSidebarHandle,
  AgentToolSidebarProps
>(function AgentToolSidebar(
  {
    children,
    containerWidth,
    copy,
    header,
    mainContentMinWidthPx,
    panels: unfilteredPanels,
    quickActionPanels,
    reminders,
    renderLoading,
    renderPanel,
    renderTabIcon,
    resolveTabLabel,
    resizeContainerContentWidth,
    onActivePanelChange,
    onLayoutWidthChange,
    onPanelOpen,
    onTabsChange,
    onTabClose
  },
  ref
): ReactNode {
  const panels = filterAgentToolPanels(unfilteredPanels);
  const labelByPanel = new Map(panels.map((panel) => [panel.id, panel.label]));
  const {
    activePanelLayoutWidth,
    activePanelMaxWidth,
    activePanelMinWidth,
    activePanelWidth,
    handleResizeKeyDown,
    handleResizePointerDown,
    handleResizePointerMove,
    isActivePanelExpanded,
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
    measureToolActions,
    mountedTabs,
    openPanel,
    shouldAnimateSidebarLayout,
    shouldAnimateSidebarWidth,
    stopResizing,
    toolActionsWidth,
    toggleSidebar,
    togglePanelExpansion
  } = useAgentToolSidebarController({
    containerWidth,
    mainContentMinWidthPx,
    onActivePanelChange,
    onLayoutWidthChange,
    onPanelOpen,
    onTabClose,
    onTabsChange,
    panels,
    resizeContainerContentWidth
  });

  useImperativeHandle(
    ref,
    () => ({
      addPanel,
      close: closePanel,
      collapseForContainerConstraint: collapseSidebarForContainerConstraint,
      closeTab: closePanelTab,
      ensurePanel,
      openPanel
    }),
    [
      addPanel,
      closePanel,
      closePanelTab,
      collapseSidebarForContainerConstraint,
      ensurePanel,
      openPanel
    ]
  );

  const isHostOwnedHeader = header.owner === "host";

  const toolActions = (
    <div
      className={cn(
        "flex h-[var(--agent-gui-workbench-header-height,44px)] min-w-0 max-w-full shrink-0 cursor-grab items-center pr-[var(--agent-gui-workbench-header-padding-x)] active:cursor-grabbing",
        isHostOwnedHeader
          ? "[-webkit-app-region:no-drag]"
          : "[-webkit-app-region:drag]",
        isSidebarOpen && "border-b border-[var(--border-1)]"
      )}
      data-agent-tool-sidebar-drag-region="true"
      data-agent-tool-sidebar-header="true"
      ref={measureToolActions}
      style={
        isSidebarOpen
          ? { width: `${activePanelWidth}px`, maxWidth: "100%" }
          : undefined
      }
    >
      {activeTabId ? (
        <ToolSidebarTabBar
          activeTabId={activeTabId}
          copy={copy}
          labelByPanel={labelByPanel}
          mountedTabs={mountedTabs}
          renderTabIcon={renderTabIcon}
          resolveTabLabel={resolveTabLabel}
          onClosePanel={closePanelTab}
          onOpenPanel={activatePanelTab}
        />
      ) : null}
      <AgentToolSidebarToolbar
        activePanel={activePanel}
        copy={copy}
        isExpanded={isActivePanelExpanded}
        isOpen={isSidebarOpen}
        panels={panels}
        quickActionPanels={quickActionPanels}
        reminders={reminders}
        onAddPanel={addPanel}
        onOpenPanel={openPanel}
        onToggleExpansion={() => {
          if (activePanel) togglePanelExpansion(activePanel);
        }}
        onToggleSidebar={toggleSidebar}
      />
    </div>
  );
  const headerLayout: AgentToolSidebarHeaderLayout = {
    actions: toolActions,
    isSidebarOpen,
    layoutWidthPx: isSidebarOpen ? activePanelLayoutWidth : toolActionsWidth
  };
  const renderedHeader = header.render(headerLayout);

  return (
    <>
      {header.owner === "host" ? (
        renderedHeader
      ) : (
        <div
          className="workbench-window__header workbench-window__header--custom"
          style={
            {
              "--agent-gui-tool-sidebar-layout-width": `${headerLayout.layoutWidthPx}px`
            } as CSSProperties
          }
        >
          {renderedHeader}
        </div>
      )}
      <div
        className={cn(
          "flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
          header.owner === "window" && "workbench-window__body"
        )}
        ref={bindLifecycle}
      >
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
            data-agent-tool-sidebar="true"
            ref={bindLayoutWidthProjection}
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
                  aria-label={copy.resizeSidebar}
                  aria-orientation="vertical"
                  aria-valuemax={activePanelMaxWidth}
                  aria-valuemin={activePanelMinWidth}
                  aria-valuenow={activePanelWidth}
                  className="absolute top-0 left-0 z-20 h-full w-2 cursor-col-resize touch-none outline-none before:absolute before:left-0 before:h-full before:w-px before:bg-transparent hover:before:bg-[var(--border-focus)] focus-visible:before:bg-[var(--border-focus)]"
                  data-agent-tool-sidebar-resize-handle="true"
                  role="separator"
                  tabIndex={0}
                  onKeyDown={handleResizeKeyDown}
                  onLostPointerCapture={stopResizing}
                  onPointerDown={handleResizePointerDown}
                  onPointerMove={handleResizePointerMove}
                  onPointerUp={stopResizing}
                />
              ) : null}
              {isSidebarOpen && header.layout === "overlay" ? (
                <div
                  aria-hidden
                  className="shrink-0"
                  data-agent-tool-sidebar-header-spacer="true"
                  style={{
                    height: "var(--agent-gui-workbench-header-height, 44px)"
                  }}
                />
              ) : null}
              <div className="relative min-h-0 flex-1 overflow-hidden">
                {isEmptySidebar || isEmptySidebarClosing ? (
                  <AgentToolSidebarPicker
                    panels={panels}
                    onSelect={openPanel}
                  />
                ) : null}
                {mountedTabs.map((tab) => (
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
                        {renderPanel({
                          active: activeTabId === tab.id,
                          closeSidebar: closePanel,
                          tab
                        })}
                      </div>
                    ) : activeTabId === tab.id ? (
                      (renderLoading?.(tab) ?? null)
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
});

function ToolSidebarTabBar({
  activeTabId,
  copy,
  labelByPanel,
  mountedTabs,
  renderTabIcon,
  resolveTabLabel,
  onClosePanel,
  onOpenPanel
}: {
  activeTabId: string;
  copy: AgentToolSidebarCopy;
  labelByPanel: ReadonlyMap<AgentToolPanelId, string>;
  mountedTabs: readonly AgentToolTab[];
  renderTabIcon?: (tab: AgentToolTab) => ReactNode;
  resolveTabLabel?: (tab: AgentToolTab, defaultLabel: string) => string;
  onClosePanel: (tabId: string) => void;
  onOpenPanel: (tab: AgentToolTab) => void;
}): ReactNode {
  return (
    <div
      aria-label={copy.tool}
      className="flex h-[var(--agent-gui-workbench-header-height,44px)] min-w-0 flex-1 cursor-grab items-center gap-1 overflow-hidden px-2 active:cursor-grabbing"
      data-agent-tool-tab-list="true"
      role="tablist"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {mountedTabs.map((tab) => {
          const defaultLabel = labelByPanel.get(tab.panel) ?? tab.panel;
          const label = resolveTabLabel?.(tab, defaultLabel) ?? defaultLabel;
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
                data-agent-tool-tab={tab.panel}
                data-agent-tool-tab-id={tab.id}
                role="tab"
                type="button"
                onClick={() => onOpenPanel(tab)}
                onDoubleClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                {renderTabIcon?.(tab) ?? (
                  <AgentToolPanelIcon
                    aria-hidden
                    className="size-3.5 shrink-0"
                    panel={tab.panel}
                  />
                )}
                <span className="truncate">{label}</span>
              </button>
              <button
                aria-label={`${copy.close} ${label}`}
                className="nodrag mr-1 rounded p-0.5 opacity-100 hover:bg-[var(--transparency-block)] [-webkit-app-region:no-drag]"
                type="button"
                onClick={() => onClosePanel(tab.id)}
                onDoubleClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
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
