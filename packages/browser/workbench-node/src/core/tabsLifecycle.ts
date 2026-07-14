import type { BrowserNodeFeature } from "./feature.ts";
import type { BrowserNodeTab } from "./tabsStore.ts";

interface BrowserNodeTabSurfaceLease {
  generation: number;
  retainCount: number;
}

const surfaceLeases = new WeakMap<
  BrowserNodeFeature,
  Map<string, BrowserNodeTabSurfaceLease>
>();

export function closeBrowserNodeTab(
  feature: BrowserNodeFeature,
  surfaceNodeId: string,
  tabId: string
): void {
  const closedTab = feature.tabsStore.closeTab(surfaceNodeId, tabId);
  if (closedTab) {
    closeTabGuest(feature, closedTab);
  }
}

export function closeBrowserNodeTabSurface(
  feature: BrowserNodeFeature,
  surfaceNodeId: string
): void {
  for (const tab of feature.tabsStore.removeSurface(surfaceNodeId)) {
    closeTabGuest(feature, tab);
  }
}

export function retainBrowserNodeTabSurface(
  feature: BrowserNodeFeature,
  surfaceNodeId: string
): () => void {
  const featureLeases = getFeatureSurfaceLeases(feature);
  const lease = featureLeases.get(surfaceNodeId) ?? {
    generation: 0,
    retainCount: 0
  };
  lease.generation += 1;
  lease.retainCount += 1;
  featureLeases.set(surfaceNodeId, lease);
  let released = false;

  return () => {
    if (released) {
      return;
    }
    released = true;
    lease.retainCount = Math.max(0, lease.retainCount - 1);
    const releaseGeneration = ++lease.generation;
    queueMicrotask(() => {
      if (lease.retainCount !== 0 || lease.generation !== releaseGeneration) {
        return;
      }
      featureLeases.delete(surfaceNodeId);
      closeBrowserNodeTabSurface(feature, surfaceNodeId);
    });
  };
}

function getFeatureSurfaceLeases(
  feature: BrowserNodeFeature
): Map<string, BrowserNodeTabSurfaceLease> {
  const existing = surfaceLeases.get(feature);
  if (existing) {
    return existing;
  }
  const leases = new Map<string, BrowserNodeTabSurfaceLease>();
  surfaceLeases.set(feature, leases);
  return leases;
}

function closeTabGuest(feature: BrowserNodeFeature, tab: BrowserNodeTab): void {
  feature.runtimeStore.clearNode(tab.nodeId);
  void feature.hostApi.close({ nodeId: tab.nodeId }).catch(() => undefined);
}
