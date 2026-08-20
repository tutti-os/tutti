import type { BrowserNodeFeature } from "./feature.ts";
import type { BrowserNodeTab } from "./tabsStore.ts";
import { normalizeBrowserComparableUrl } from "./url.ts";

export function findBrowserNodePageByUrl(
  feature: BrowserNodeFeature,
  surfaceNodeId: string,
  url: string
): BrowserNodeTab | null {
  const comparableUrl = normalizeBrowserComparableUrl(url);
  if (!comparableUrl) {
    return null;
  }

  const state = feature.tabsStore.getSurfaceState(surfaceNodeId);
  if (!state) {
    return null;
  }

  const livePage = state.tabs.find((tab) => {
    const runtimeUrl = feature.runtimeStore.getNodeState(tab.nodeId).url;
    return normalizeBrowserComparableUrl(runtimeUrl ?? "") === comparableUrl;
  });
  return (
    livePage ??
    state.tabs.find(
      (tab) => normalizeBrowserComparableUrl(tab.defaultUrl) === comparableUrl
    ) ??
    null
  );
}

export function activateBrowserNodePageByUrl(
  feature: BrowserNodeFeature,
  surfaceNodeId: string,
  url: string
): BrowserNodeTab | null {
  const page = findBrowserNodePageByUrl(feature, surfaceNodeId, url);
  if (!page) {
    return null;
  }
  feature.tabsStore.selectTab(surfaceNodeId, page.id);
  return page;
}
