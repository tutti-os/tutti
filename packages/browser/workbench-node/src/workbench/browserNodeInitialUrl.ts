import type { WorkbenchHostActivation } from "@tutti-os/workbench-surface";
import type { BrowserNodeTabsStore } from "../core/tabsStore.ts";

export interface BrowserNodeOpenUrlActivationPayload {
  title?: string;
  url: string;
}

export interface BrowserNodeExternalState {
  title?: string | null;
  url?: string | null;
}

export function resolveBrowserNodeInitialUrl({
  activation,
  defaultUrl,
  externalNodeState,
  surfaceNodeId,
  tabsStore
}: {
  activation: WorkbenchHostActivation | null;
  defaultUrl: string;
  externalNodeState?: BrowserNodeExternalState | null;
  surfaceNodeId: string;
  tabsStore: Pick<BrowserNodeTabsStore, "getSurfaceState">;
}): string {
  return (
    readBrowserOpenUrlActivationPayload(activation)?.url ??
    normalizeBrowserNodeInitialUrl(externalNodeState?.url) ??
    readActiveBrowserTabDefaultUrl(tabsStore, surfaceNodeId) ??
    defaultUrl
  );
}

function readActiveBrowserTabDefaultUrl(
  tabsStore: Pick<BrowserNodeTabsStore, "getSurfaceState">,
  surfaceNodeId: string
): string | null {
  const state = tabsStore.getSurfaceState(surfaceNodeId);
  return normalizeBrowserNodeInitialUrl(
    state?.tabs.find((tab) => tab.id === state.activeTabId)?.defaultUrl
  );
}

function normalizeBrowserNodeInitialUrl(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function readBrowserOpenUrlActivationPayload(
  activation: WorkbenchHostActivation | null
): BrowserNodeOpenUrlActivationPayload | null {
  if (
    activation?.type !== "open-url" ||
    !activation.payload ||
    typeof activation.payload !== "object"
  ) {
    return null;
  }

  const typed =
    activation.payload as Partial<BrowserNodeOpenUrlActivationPayload>;
  return typeof typed.url === "string"
    ? {
        title: typeof typed.title === "string" ? typed.title : undefined,
        url: typed.url
      }
    : null;
}
