import type { BrowserNodeFeature } from "@tutti-os/browser-node";

export function createAgentToolBrowserPage(
  feature: BrowserNodeFeature,
  surfaceNodeId: string,
  defaultUrl: string,
  url?: string | null
): string {
  const resolvedUrl = url?.trim() || "about:blank";
  const state = feature.tabsStore.ensureSurface(surfaceNodeId, defaultUrl, {
    materializeCold: true
  });
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  const activeRuntime = activeTab
    ? feature.runtimeStore.getNodeState(activeTab.nodeId)
    : null;
  if (
    state.tabs.length === 1 &&
    activeTab?.defaultUrl === "about:blank" &&
    !activeRuntime?.url
  ) {
    feature.tabsStore.syncDefaultUrl(surfaceNodeId, resolvedUrl);
    return activeTab.nodeId;
  }
  return feature.tabsStore.addTab(surfaceNodeId, resolvedUrl, {
    materializeCold: true
  }).nodeId;
}
