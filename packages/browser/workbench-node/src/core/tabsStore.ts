export interface BrowserNodeTab {
  defaultUrl: string;
  id: string;
  nodeId: string;
}

export interface BrowserNodeTabsState {
  activeTabId: string;
  tabs: readonly BrowserNodeTab[];
}

export interface BrowserNodeTabsStore {
  addTab(surfaceNodeId: string): BrowserNodeTab;
  closeTab(surfaceNodeId: string, tabId: string): BrowserNodeTab | null;
  ensureSurface(
    surfaceNodeId: string,
    defaultUrl: string
  ): BrowserNodeTabsState;
  getActiveNodeId(surfaceNodeId: string): string;
  getSurfaceState(surfaceNodeId: string): BrowserNodeTabsState | null;
  removeSurface(surfaceNodeId: string): readonly BrowserNodeTab[];
  selectTab(surfaceNodeId: string, tabId: string): void;
  subscribe(listener: () => void): () => void;
  syncDefaultUrl(surfaceNodeId: string, defaultUrl: string): void;
}

export function createBrowserNodeTabsStore(): BrowserNodeTabsStore {
  const states = new Map<string, BrowserNodeTabsState>();
  const defaultUrls = new Map<string, string>();
  const nextSequences = new Map<string, number>();
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const createTab = (surfaceNodeId: string): BrowserNodeTab => {
    const sequence = nextSequences.get(surfaceNodeId) ?? 1;
    nextSequences.set(surfaceNodeId, sequence + 1);
    return {
      defaultUrl: defaultUrls.get(surfaceNodeId) ?? "about:blank",
      id: `tab-${sequence}`,
      nodeId: `${surfaceNodeId}:tab:${sequence}`
    };
  };

  const ensureSurface = (
    surfaceNodeId: string,
    defaultUrl: string
  ): BrowserNodeTabsState => {
    const existing = states.get(surfaceNodeId);
    if (existing) {
      return existing;
    }

    defaultUrls.set(surfaceNodeId, defaultUrl);
    const tab = createTab(surfaceNodeId);
    const state = {
      activeTabId: tab.id,
      tabs: [tab]
    } satisfies BrowserNodeTabsState;
    states.set(surfaceNodeId, state);
    return state;
  };

  return {
    addTab(surfaceNodeId) {
      const current = states.get(surfaceNodeId);
      if (!current) {
        throw new Error(
          `Browser tab surface is not initialized: ${surfaceNodeId}`
        );
      }
      const tab = createTab(surfaceNodeId);
      states.set(surfaceNodeId, {
        activeTabId: tab.id,
        tabs: [...current.tabs, tab]
      });
      emit();
      return tab;
    },
    closeTab(surfaceNodeId, tabId) {
      const current = states.get(surfaceNodeId);
      if (!current || current.tabs.length === 1) {
        return null;
      }
      const tabIndex = current.tabs.findIndex((tab) => tab.id === tabId);
      if (tabIndex === -1) {
        return null;
      }

      const closedTab = current.tabs[tabIndex];
      if (!closedTab) {
        return null;
      }
      const tabs = current.tabs.filter((tab) => tab.id !== tabId);
      const fallbackTab = tabs[Math.min(tabIndex, tabs.length - 1)];
      states.set(surfaceNodeId, {
        activeTabId:
          current.activeTabId === tabId
            ? (fallbackTab?.id ?? tabs[0]?.id ?? current.activeTabId)
            : current.activeTabId,
        tabs
      });
      emit();
      return closedTab;
    },
    ensureSurface,
    getActiveNodeId(surfaceNodeId) {
      const state = states.get(surfaceNodeId);
      return (
        state?.tabs.find((tab) => tab.id === state.activeTabId)?.nodeId ??
        surfaceNodeId
      );
    },
    getSurfaceState(surfaceNodeId) {
      return states.get(surfaceNodeId) ?? null;
    },
    removeSurface(surfaceNodeId) {
      const tabs = states.get(surfaceNodeId)?.tabs ?? [];
      if (states.delete(surfaceNodeId)) {
        defaultUrls.delete(surfaceNodeId);
        nextSequences.delete(surfaceNodeId);
        emit();
      }
      return tabs;
    },
    selectTab(surfaceNodeId, tabId) {
      const current = states.get(surfaceNodeId);
      if (
        !current ||
        current.activeTabId === tabId ||
        !current.tabs.some((tab) => tab.id === tabId)
      ) {
        return;
      }
      states.set(surfaceNodeId, { ...current, activeTabId: tabId });
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    syncDefaultUrl(surfaceNodeId, defaultUrl) {
      const current = ensureSurface(surfaceNodeId, defaultUrl);
      const activeTab = current.tabs.find(
        (tab) => tab.id === current.activeTabId
      );
      if (!activeTab || activeTab.defaultUrl === defaultUrl) {
        return;
      }
      states.set(surfaceNodeId, {
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.id === activeTab.id ? { ...tab, defaultUrl } : tab
        )
      });
      emit();
    }
  };
}
