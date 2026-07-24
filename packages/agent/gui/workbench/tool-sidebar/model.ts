export const agentToolPanelIds = [
  "files",
  "terminal",
  "browser",
  "tasks",
  "apps",
  "messages"
] as const;

export type AgentToolPanelId = (typeof agentToolPanelIds)[number];

export interface AgentToolPanelDefinition {
  id: AgentToolPanelId;
  label: string;
}

export interface AgentToolTab {
  id: string;
  panel: AgentToolPanelId;
  resourceId?: string;
}

const supportedPanelIds = new Set<string>(agentToolPanelIds);

export function isAgentToolPanelId(value: string): value is AgentToolPanelId {
  return supportedPanelIds.has(value);
}

export function filterAgentToolPanels(
  panels: readonly { id: string; label: string }[]
): AgentToolPanelDefinition[] {
  const seen = new Set<AgentToolPanelId>();
  const filtered: AgentToolPanelDefinition[] = [];
  for (const panel of panels) {
    if (!isAgentToolPanelId(panel.id) || seen.has(panel.id)) {
      continue;
    }
    seen.add(panel.id);
    filtered.push({ id: panel.id, label: panel.label });
  }
  return filtered;
}

const adjacentPanelDefaultWidth = 720;
export const agentToolEmptySidebarWidth = Math.round(
  adjacentPanelDefaultWidth * 0.6
);
export const agentToolMainMinWidth = 280;

export const agentToolPanelDefaultWidthById: Record<AgentToolPanelId, number> =
  {
    apps: adjacentPanelDefaultWidth,
    browser: adjacentPanelDefaultWidth,
    files: adjacentPanelDefaultWidth,
    messages: 440,
    tasks: 860,
    terminal: adjacentPanelDefaultWidth
  };

export const agentToolPanelMinWidthById: Record<AgentToolPanelId, number> = {
  apps: 420,
  browser: 420,
  files: 480,
  messages: 320,
  tasks: 420,
  terminal: 420
};

export const agentToolPanelMaxWidthById: Record<AgentToolPanelId, number> = {
  apps: 1_200,
  browser: 1_200,
  files: Number.MAX_SAFE_INTEGER,
  messages: 1_200,
  tasks: 1_200,
  terminal: 1_200
};

export interface AgentToolSidebarState {
  activePanel: AgentToolPanelId | null;
  activeTabId: string | null;
  mountedTabs: AgentToolTab[];
}

export type AgentToolSidebarAction =
  | {
      panel: AgentToolPanelId;
      resourceId?: string;
      tabId: string;
      type: "open-panel" | "add-panel" | "ensure-panel";
    }
  | { tabId: string; type: "activate-tab" | "close-tab" }
  | { type: "close" };

export function createAgentToolSidebarState(
  initial?: Partial<AgentToolSidebarState>
): AgentToolSidebarState {
  const activePanel = initial?.activePanel ?? null;
  const mountedTabs = initial?.mountedTabs ?? [];
  const activeTabId =
    initial?.activeTabId ??
    (activePanel === null
      ? null
      : (findLastTab(mountedTabs, activePanel)?.id ?? null));
  return {
    activePanel: activeTabId === null ? null : activePanel,
    activeTabId,
    mountedTabs
  };
}

export function reduceAgentToolSidebarState(
  state: AgentToolSidebarState,
  action: AgentToolSidebarAction
): AgentToolSidebarState {
  switch (action.type) {
    case "close":
      return state.activeTabId === null
        ? state
        : { ...state, activePanel: null, activeTabId: null };
    case "close-tab": {
      const closingIndex = state.mountedTabs.findIndex(
        (tab) => tab.id === action.tabId
      );
      if (closingIndex < 0) {
        return state;
      }
      const mountedTabs = state.mountedTabs.filter(
        (tab) => tab.id !== action.tabId
      );
      if (state.activeTabId !== action.tabId) {
        return { ...state, mountedTabs };
      }
      const nextTab =
        mountedTabs[Math.max(0, closingIndex - 1)] ?? mountedTabs[0] ?? null;
      return {
        activePanel: nextTab?.panel ?? null,
        activeTabId: nextTab?.id ?? null,
        mountedTabs
      };
    }
    case "activate-tab": {
      const tab = state.mountedTabs.find(
        (candidate) => candidate.id === action.tabId
      );
      return tab
        ? { ...state, activePanel: tab.panel, activeTabId: tab.id }
        : state;
    }
    case "add-panel":
      return addTab(state, action);
    case "ensure-panel": {
      const existing = findLastTab(
        state.mountedTabs,
        action.panel,
        action.resourceId
      );
      return existing ? state : addTab(state, action, { activate: false });
    }
    case "open-panel": {
      const existing = findLastTab(
        state.mountedTabs,
        action.panel,
        action.resourceId
      );
      return existing
        ? { ...state, activePanel: existing.panel, activeTabId: existing.id }
        : addTab(state, action);
    }
  }
}

function addTab(
  state: AgentToolSidebarState,
  tab: {
    panel: AgentToolPanelId;
    resourceId?: string;
    tabId: string;
  },
  options: { activate?: boolean } = {}
): AgentToolSidebarState {
  const nextTab: AgentToolTab = {
    id: tab.tabId,
    panel: tab.panel,
    ...(tab.resourceId ? { resourceId: tab.resourceId } : {})
  };
  const activate = options.activate !== false;
  return {
    activePanel: activate ? nextTab.panel : state.activePanel,
    activeTabId: activate ? nextTab.id : state.activeTabId,
    mountedTabs: state.mountedTabs.some(
      (candidate) => candidate.id === nextTab.id
    )
      ? state.mountedTabs
      : [...state.mountedTabs, nextTab]
  };
}

function findLastTab(
  tabs: readonly AgentToolTab[],
  panel: AgentToolPanelId,
  resourceId?: string
): AgentToolTab | null {
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index];
    if (tab?.panel === panel && (tab.resourceId ?? undefined) === resourceId) {
      return tab;
    }
  }
  return null;
}

export function resolveAgentToolPanelExpansionReset(input: {
  expandedPanel: AgentToolPanelId | null;
  nextPanel: AgentToolPanelId | null;
  widthBeforeExpansion?: number;
}): { panel: AgentToolPanelId; width: number } | null {
  if (input.expandedPanel === null || input.expandedPanel === input.nextPanel) {
    return null;
  }
  return {
    panel: input.expandedPanel,
    width:
      typeof input.widthBeforeExpansion === "number" &&
      Number.isFinite(input.widthBeforeExpansion)
        ? input.widthBeforeExpansion
        : agentToolPanelDefaultWidthById[input.expandedPanel]
  };
}

export function resolveAgentToolPanelExpansionTransfer(input: {
  expandedPanel: AgentToolPanelId | null;
  nextPanel: AgentToolPanelId | null;
  nextPanelWidth: number;
  widthBeforeExpansion?: number;
}): {
  expandedPanel: AgentToolPanelId;
  nextPanelWidthBeforeExpansion: number;
  previousPanel: AgentToolPanelId;
  previousPanelWidth: number;
} | null {
  const reset = resolveAgentToolPanelExpansionReset(input);
  if (!reset || input.nextPanel === null) {
    return null;
  }
  return {
    expandedPanel: input.nextPanel,
    nextPanelWidthBeforeExpansion:
      Number.isFinite(input.nextPanelWidth) && input.nextPanelWidth > 0
        ? input.nextPanelWidth
        : agentToolPanelDefaultWidthById[input.nextPanel],
    previousPanel: reset.panel,
    previousPanelWidth: reset.width
  };
}

export function resolveAgentToolPanelMaxWidth(
  panel: AgentToolPanelId,
  viewportWidth: number,
  allowFullWidth = false,
  mainContentMinWidth = agentToolMainMinWidth
): number {
  const resolvedMainMin = Number.isFinite(mainContentMinWidth)
    ? Math.max(0, mainContentMinWidth)
    : agentToolMainMinWidth;
  const resolvedViewport = Number.isFinite(viewportWidth)
    ? viewportWidth
    : resolvedMainMin + agentToolPanelMinWidthById[panel];
  return Math.max(
    0,
    Math.min(
      allowFullWidth
        ? Number.MAX_SAFE_INTEGER
        : agentToolPanelMaxWidthById[panel],
      resolvedViewport - resolvedMainMin
    )
  );
}

export function clampAgentToolPanelWidth(input: {
  allowFullWidth?: boolean;
  mainContentMinWidth?: number;
  panel: AgentToolPanelId;
  viewportWidth: number;
  width: number;
}): number {
  const maxWidth = resolveAgentToolPanelMaxWidth(
    input.panel,
    input.viewportWidth,
    input.allowFullWidth,
    input.mainContentMinWidth
  );
  const minWidth = Math.min(agentToolPanelMinWidthById[input.panel], maxWidth);
  const width = Number.isFinite(input.width)
    ? input.width
    : agentToolPanelDefaultWidthById[input.panel];
  return Math.round(Math.min(maxWidth, Math.max(minWidth, width)));
}

export function resolveAgentToolSidebarWidth(input: {
  allowFullWidth?: boolean;
  baselineViewportWidth: number;
  mainContentMinWidth?: number;
  panel: AgentToolPanelId;
  preferredWidth: number;
  viewportWidth: number;
}): number {
  const baseline = Number.isFinite(input.baselineViewportWidth)
    ? Math.max(0, input.baselineViewportWidth)
    : input.viewportWidth;
  return clampAgentToolPanelWidth({
    allowFullWidth: input.allowFullWidth,
    mainContentMinWidth: input.mainContentMinWidth,
    panel: input.panel,
    viewportWidth: input.viewportWidth,
    width: Math.max(input.preferredWidth, input.viewportWidth - baseline)
  });
}

export function resolveAgentToolSidebarLayoutWidth(input: {
  baselineContainerWidth: number;
  panelWidth: number;
  containerWidth: number;
}): number {
  return Math.round(Math.max(0, input.panelWidth));
}

export function resolveAgentToolPanelPreferredWidth(input: {
  isExpanded: boolean;
  manuallyResizedWidth?: number | null;
  panelWidth: number;
}): number {
  return !input.isExpanded &&
    typeof input.manuallyResizedWidth === "number" &&
    Number.isFinite(input.manuallyResizedWidth)
    ? input.manuallyResizedWidth
    : input.panelWidth;
}

export function shouldResizeAgentToolContainer(input: {
  currentWidth: number;
  lastResize?: { actualWidth: number; requestedWidth: number } | null;
  requestedWidth: number;
}): boolean {
  return (
    input.currentWidth !== input.requestedWidth &&
    !(
      input.lastResize?.requestedWidth === input.requestedWidth &&
      input.lastResize.actualWidth === input.currentWidth
    )
  );
}

export function shouldAutoCollapseAgentToolSidebar(input: {
  containerWidth: number;
  mainContentMinWidth: number;
  sidebarWidth: number;
}): boolean {
  if (
    !Number.isFinite(input.containerWidth) ||
    input.containerWidth <= 0 ||
    !Number.isFinite(input.mainContentMinWidth) ||
    !Number.isFinite(input.sidebarWidth)
  ) {
    return false;
  }
  return (
    input.containerWidth <
    Math.max(0, input.mainContentMinWidth) + Math.max(0, input.sidebarWidth)
  );
}

export function formatAgentToolReminderCount(
  value: number | null | undefined
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const count = Math.floor(value);
  return count > 99 ? "99+" : String(count);
}
