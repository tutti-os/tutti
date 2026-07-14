import type { BrowserNodeFeature } from "../core/feature.ts";
import type { BrowserNodeControllerState } from "../core/nodeController.ts";

export function resolveBrowserNodeOpenExternalUrl(
  feature: BrowserNodeFeature,
  state: BrowserNodeControllerState
): string | null {
  if (!feature.hostApi.openExternal) {
    return null;
  }

  const sourceUrl = state.runtime.url?.trim() || state.displayUrl.trim();
  if (sourceUrl.length === 0 || sourceUrl === "about:blank") {
    return null;
  }

  return feature.resolveOpenExternalUrl(sourceUrl).url;
}

export async function openBrowserNodeExternal(
  feature: BrowserNodeFeature,
  url: string
): Promise<void> {
  try {
    await feature.hostApi.openExternal?.({ url });
  } catch (error) {
    feature.reportDiagnostic?.({
      details: {
        error: error instanceof Error ? error.message : String(error),
        url
      },
      event: "open-external-failed",
      level: "warn"
    });
  }
}

export async function openBrowserNodeDevTools(
  feature: BrowserNodeFeature,
  nodeId: string
): Promise<void> {
  try {
    await feature.hostApi.openDevTools?.({ nodeId });
  } catch (error) {
    feature.reportDiagnostic?.({
      details: {
        error: error instanceof Error ? error.message : String(error),
        nodeId
      },
      event: "open-devtools-failed",
      level: "warn"
    });
  }
}
