const workspaceAppWebviewSelector = 'webview[data-browser-node-webview="true"]';

export interface StandaloneAgentAppViewerSurface {
  clientHeight: number;
  clientWidth: number;
  querySelector(selectors: string): {
    style: { height: string; width: string };
  } | null;
}

export function syncStandaloneAgentAppViewerWebviewBounds(
  surface: StandaloneAgentAppViewerSurface
): boolean {
  const width = Math.round(surface.clientWidth);
  const height = Math.round(surface.clientHeight);
  const webview = surface.querySelector(workspaceAppWebviewSelector);
  if (!webview || width <= 0 || height <= 0) return false;

  const nextWidth = `${width}px`;
  const nextHeight = `${height}px`;
  if (webview.style.width !== nextWidth) webview.style.width = nextWidth;
  if (webview.style.height !== nextHeight) webview.style.height = nextHeight;
  return true;
}
