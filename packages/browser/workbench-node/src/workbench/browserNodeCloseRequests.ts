import type { WorkbenchHostNodeHeaderWindowActions } from "@tutti-os/workbench-surface";

export function createBrowserNodeWorkbenchCloseRequests(
  windowActions: Pick<WorkbenchHostNodeHeaderWindowActions, "close">
): { onFinalTabCloseRequest: () => void } {
  return {
    onFinalTabCloseRequest: () => windowActions.close()
  };
}
