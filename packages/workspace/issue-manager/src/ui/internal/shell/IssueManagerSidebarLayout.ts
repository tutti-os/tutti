export interface IssueManagerSidebarLayoutState {
  isCollapsed: boolean;
  isResizing: boolean;
  width: number;
}

export function publishIssueManagerSidebarLayout(
  layout: HTMLElement | null,
  state: IssueManagerSidebarLayoutState
): HTMLElement | null {
  if (!layout) {
    return null;
  }

  const scope = layout.closest<HTMLElement>(".workbench-window") ?? layout;
  scope.style.setProperty("--issue-manager-sidebar-width", `${state.width}px`);
  scope.dataset.issueManagerSidebarCollapsed = state.isCollapsed
    ? "true"
    : "false";
  scope.dataset.issueManagerSidebarResizing = state.isResizing
    ? "true"
    : "false";
  return scope;
}

export function clearIssueManagerSidebarLayout(
  scope: HTMLElement | null
): void {
  if (!scope) {
    return;
  }

  scope.style.removeProperty("--issue-manager-sidebar-width");
  delete scope.dataset.issueManagerSidebarCollapsed;
  delete scope.dataset.issueManagerSidebarResizing;
}
