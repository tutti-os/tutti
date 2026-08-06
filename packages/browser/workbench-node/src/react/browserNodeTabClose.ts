export type BrowserNodeTabCloseIntent = "surface" | "tab";

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
