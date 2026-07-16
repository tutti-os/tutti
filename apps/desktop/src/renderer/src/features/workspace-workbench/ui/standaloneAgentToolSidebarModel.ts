export type StandaloneAgentToolPanelId =
  | "files"
  | "browser"
  | "apps"
  | "tasks"
  | "messages"
  | "terminal";

export type StandaloneAgentSharedToolPanelId = "terminal";
export type StandaloneAgentToolLauncherPanelId =
  | "browser"
  | StandaloneAgentSharedToolPanelId;

const standaloneAgentBrowserAndAppsDefaultWidth = 720;
export const standaloneAgentEmptyToolSidebarWidth = Math.round(
  standaloneAgentBrowserAndAppsDefaultWidth * 0.6
);

export const standaloneAgentToolPanelDefaultWidthById: Record<
  StandaloneAgentToolPanelId,
  number
> = {
  apps: standaloneAgentBrowserAndAppsDefaultWidth,
  browser: standaloneAgentBrowserAndAppsDefaultWidth,
  files: standaloneAgentBrowserAndAppsDefaultWidth,
  tasks: 860,
  messages: 440,
  terminal: standaloneAgentBrowserAndAppsDefaultWidth
};

export const standaloneAgentToolPanelMinWidthById: Record<
  StandaloneAgentToolPanelId,
  number
> = {
  apps: 420,
  browser: 420,
  files: 480,
  tasks: 420,
  messages: 320,
  terminal: 420
};

export const standaloneAgentToolPanelMaxWidthById: Record<
  StandaloneAgentToolPanelId,
  number
> = {
  apps: 1_200,
  browser: 1_200,
  files: Number.MAX_SAFE_INTEGER,
  tasks: 1_200,
  messages: 1_200,
  terminal: 1_200
};
export const standaloneAgentMainMinWidth = 280;

export interface StandaloneAgentToolTab {
  appId?: string;
  id: string;
  panel: StandaloneAgentToolPanelId;
}

export function resolveStandaloneAgentToolPanelExpansionReset(input: {
  expandedPanel: StandaloneAgentToolPanelId | null;
  nextPanel: StandaloneAgentToolPanelId | null;
  widthBeforeExpansion?: number;
}): { panel: StandaloneAgentToolPanelId; width: number } | null {
  if (input.expandedPanel === null || input.expandedPanel === input.nextPanel) {
    return null;
  }

  return {
    panel: input.expandedPanel,
    width:
      typeof input.widthBeforeExpansion === "number" &&
      Number.isFinite(input.widthBeforeExpansion)
        ? input.widthBeforeExpansion
        : standaloneAgentToolPanelDefaultWidthById[input.expandedPanel]
  };
}

export function resolveStandaloneAgentToolPanelExpansionTransfer(input: {
  expandedPanel: StandaloneAgentToolPanelId | null;
  nextPanel: StandaloneAgentToolPanelId | null;
  nextPanelWidth: number;
  widthBeforeExpansion?: number;
}): {
  expandedPanel: StandaloneAgentToolPanelId;
  nextPanelWidthBeforeExpansion: number;
  previousPanel: StandaloneAgentToolPanelId;
  previousPanelWidth: number;
} | null {
  const reset = resolveStandaloneAgentToolPanelExpansionReset(input);
  if (!reset || input.nextPanel === null) {
    return null;
  }

  return {
    expandedPanel: input.nextPanel,
    nextPanelWidthBeforeExpansion:
      Number.isFinite(input.nextPanelWidth) && input.nextPanelWidth > 0
        ? input.nextPanelWidth
        : standaloneAgentToolPanelDefaultWidthById[input.nextPanel],
    previousPanel: reset.panel,
    previousPanelWidth: reset.width
  };
}

export interface StandaloneAgentToolSidebarState {
  activePanel: StandaloneAgentToolPanelId | null;
  activeTabId: string | null;
  mountedTabs: StandaloneAgentToolTab[];
}

export type StandaloneAgentToolSidebarAction =
  | {
      appId?: string;
      panel: StandaloneAgentToolPanelId;
      tabId: string;
      type: "open-panel";
    }
  | {
      appId?: string;
      panel: StandaloneAgentToolPanelId;
      tabId: string;
      type: "add-panel";
    }
  | {
      tabId: string;
      type: "activate-tab" | "close-tab";
    }
  | { type: "close" };

export function createStandaloneAgentToolSidebarState(
  initial?: Partial<StandaloneAgentToolSidebarState>
): StandaloneAgentToolSidebarState {
  const activePanel = initial?.activePanel ?? null;
  const mountedTabs = initial?.mountedTabs ?? [];
  const activeTabId =
    initial?.activeTabId ??
    (activePanel === null
      ? null
      : (findLastTabByPanel(mountedTabs, activePanel)?.id ?? null));
  return {
    activePanel: activeTabId === null ? null : activePanel,
    activeTabId,
    mountedTabs
  };
}

function addTab(
  state: StandaloneAgentToolSidebarState,
  tab: StandaloneAgentToolTab
): StandaloneAgentToolSidebarState {
  const mountedTabs = state.mountedTabs.some(
    (candidate) => candidate.id === tab.id
  )
    ? state.mountedTabs
    : [...state.mountedTabs, tab];
  return {
    activePanel: tab.panel,
    activeTabId: tab.id,
    mountedTabs
  };
}

function findLastTabByPanel(
  tabs: readonly StandaloneAgentToolTab[],
  panel: StandaloneAgentToolPanelId,
  appId?: string
): StandaloneAgentToolTab | null {
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index];
    if (tab?.panel === panel && (tab.appId ?? undefined) === appId) {
      return tab;
    }
  }
  return null;
}

export function reduceStandaloneAgentToolSidebarState(
  state: StandaloneAgentToolSidebarState,
  action: StandaloneAgentToolSidebarAction
): StandaloneAgentToolSidebarState {
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
      if (!tab) {
        return state;
      }
      return {
        ...state,
        activePanel: tab.panel,
        activeTabId: tab.id
      };
    }
    case "add-panel":
      return addTab(state, {
        ...(action.appId ? { appId: action.appId } : {}),
        id: action.tabId,
        panel: action.panel
      });
    case "open-panel": {
      const existingTab = findLastTabByPanel(
        state.mountedTabs,
        action.panel,
        action.appId
      );
      if (existingTab) {
        return {
          ...state,
          activePanel: existingTab.panel,
          activeTabId: existingTab.id
        };
      }
      return addTab(state, {
        ...(action.appId ? { appId: action.appId } : {}),
        id: action.tabId,
        panel: action.panel
      });
    }
  }
}

export function isStandaloneAgentToolGroupActive(
  state: StandaloneAgentToolSidebarState
): boolean {
  return state.activePanel === "browser" || state.activePanel === "terminal";
}

export function formatStandaloneAgentToolReminderCount(
  value: number | null | undefined
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const count = Math.floor(value);
  return count > 99 ? "99+" : String(count);
}

export function clampStandaloneAgentToolPanelWidth(input: {
  allowFullWidth?: boolean;
  mainContentMinWidth?: number;
  panel: StandaloneAgentToolPanelId;
  viewportWidth: number;
  width: number;
}): number {
  const maxWidth = resolveStandaloneAgentToolPanelMaxWidth(
    input.panel,
    input.viewportWidth,
    input.allowFullWidth,
    input.mainContentMinWidth
  );
  const minWidth = Math.min(
    standaloneAgentToolPanelMinWidthById[input.panel],
    maxWidth
  );
  const width = Number.isFinite(input.width)
    ? input.width
    : standaloneAgentToolPanelDefaultWidthById[input.panel];
  return Math.round(Math.min(maxWidth, Math.max(minWidth, width)));
}

export function resolveStandaloneAgentToolSidebarWidth(input: {
  allowFullWidth?: boolean;
  baselineViewportWidth: number;
  mainContentMinWidth?: number;
  panel: StandaloneAgentToolPanelId;
  preferredWidth: number;
  viewportWidth: number;
}): number {
  const baselineViewportWidth = Number.isFinite(input.baselineViewportWidth)
    ? Math.max(0, input.baselineViewportWidth)
    : input.viewportWidth;
  const outwardWidth = Math.max(0, input.viewportWidth - baselineViewportWidth);

  return clampStandaloneAgentToolPanelWidth({
    allowFullWidth: input.allowFullWidth,
    mainContentMinWidth: input.mainContentMinWidth,
    panel: input.panel,
    viewportWidth: input.viewportWidth,
    width: Math.max(input.preferredWidth, outwardWidth)
  });
}

export function resolveStandaloneAgentToolPanelPreferredWidth(input: {
  isExpanded: boolean;
  manuallyResizedWidth?: number | null;
  panelWidth: number;
}): number {
  if (
    !input.isExpanded &&
    typeof input.manuallyResizedWidth === "number" &&
    Number.isFinite(input.manuallyResizedWidth)
  ) {
    return input.manuallyResizedWidth;
  }
  return input.panelWidth;
}

export function shouldResizeStandaloneAgentToolWindow(input: {
  currentWidth: number;
  lastResize?: {
    actualWidth: number;
    requestedWidth: number;
  } | null;
  requestedWidth: number;
}): boolean {
  if (input.currentWidth === input.requestedWidth) {
    return false;
  }
  return !(
    input.lastResize?.requestedWidth === input.requestedWidth &&
    input.lastResize.actualWidth === input.currentWidth
  );
}

export function resolveStandaloneAgentToolSidebarLayoutWidth(input: {
  baselineViewportWidth: number;
  panelWidth: number;
  viewportWidth: number;
}): number {
  return Math.round(Math.max(0, input.panelWidth));
}

export function resolveStandaloneAgentToolPanelMaxWidth(
  panel: StandaloneAgentToolPanelId,
  viewportWidth: number,
  allowFullWidth = false,
  mainContentMinWidth = standaloneAgentMainMinWidth
): number {
  const minWidth = standaloneAgentToolPanelMinWidthById[panel];
  const resolvedMainContentMinWidth = Number.isFinite(mainContentMinWidth)
    ? Math.max(0, mainContentMinWidth)
    : standaloneAgentMainMinWidth;
  const resolvedViewportWidth = Number.isFinite(viewportWidth)
    ? viewportWidth
    : resolvedMainContentMinWidth + minWidth;
  return Math.max(
    0,
    Math.min(
      allowFullWidth
        ? Number.MAX_SAFE_INTEGER
        : standaloneAgentToolPanelMaxWidthById[panel],
      resolvedViewportWidth - resolvedMainContentMinWidth
    )
  );
}
