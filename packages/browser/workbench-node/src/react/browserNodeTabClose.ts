export type BrowserNodeTabCloseIntent = "surface" | "tab";

export function resolveBrowserNodeFinalTabCloseRequest(input: {
  onCloseRequest?: () => void;
  onFinalTabCloseRequest?: () => void;
}): (() => void) | undefined {
  return input.onFinalTabCloseRequest ?? input.onCloseRequest;
}

export function resolveBrowserNodeTabCloseIntent(input: {
  hasSurfaceCloseRequest: boolean;
  tabCount: number;
}): BrowserNodeTabCloseIntent | null {
  if (input.tabCount > 1) {
    return "tab";
  }
  return input.tabCount === 1 && input.hasSurfaceCloseRequest
    ? "surface"
    : null;
}
