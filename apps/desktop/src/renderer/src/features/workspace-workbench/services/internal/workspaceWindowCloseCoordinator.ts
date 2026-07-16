import type {
  WorkbenchHostCloseDialogRequest,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import type { WorkspaceWorkbenchHostInput } from "../workspaceWorkbenchHostService.interface";
import type { WindowCloseRequestTracker } from "../windowCloseRequestTracker";

export async function confirmWorkspaceWindowClose(input: {
  confirmCloseGuard(request: WorkbenchHostCloseDialogRequest): Promise<boolean>;
  host: WorkbenchHostHandle | null;
  hostInput: Pick<
    WorkspaceWorkbenchHostInput,
    "createWindowCloseDialogRequest" | "prepareHostClose" | "workspaceId"
  >;
  reason: "quit" | "window-close";
  requestApprovedClose(): Promise<void>;
  tracker: WindowCloseRequestTracker;
}): Promise<"approved" | "blocked"> {
  if (input.reason === "window-close") {
    const host = input.host;
    if (host) {
      const focusedNodeId = resolveFocusedVisibleNodeId(host);
      if (focusedNodeId) {
        host.requestNodeClose(focusedNodeId);
        return "blocked";
      }
    }

    return requestWorkspaceWindowClose({
      requestApprovedClose: () => input.requestApprovedClose(),
      tracker: input.tracker
    });
  }

  const host = input.host;
  if (host) {
    const snapshot = host.getSnapshot();
    const nodes = snapshot.nodes;
    if (
      nodes.length > 0 &&
      input.hostInput.prepareHostClose &&
      !(await input.hostInput.prepareHostClose({
        host,
        workspaceId: input.hostInput.workspaceId
      }))
    ) {
      return "blocked";
    }
    if (nodes.length > 0) {
      host.closeNode(resolveQuitCloseNodeId(snapshot));
      return "blocked";
    }
  }

  return requestWorkspaceWindowClose({
    requestApprovedClose: () => input.requestApprovedClose(),
    tracker: input.tracker
  });
}

async function requestWorkspaceWindowClose(input: {
  requestApprovedClose(): Promise<void>;
  tracker: WindowCloseRequestTracker;
}): Promise<"approved" | "blocked"> {
  if (input.tracker.isClosing) {
    return "blocked";
  }

  input.tracker.begin();
  try {
    await input.requestApprovedClose();
    return "approved";
  } finally {
    input.tracker.finish();
  }
}

function resolveFocusedVisibleNodeId(host: WorkbenchHostHandle): string | null {
  const snapshot = host.getSnapshot();
  const focusedNodeId = snapshot.nodeStack.at(-1);
  const visibleNodes = snapshot.nodes.filter((node) => !node.isMinimized);
  if (focusedNodeId) {
    const focusedNode = visibleNodes.find((node) => node.id === focusedNodeId);
    if (focusedNode) {
      return focusedNode.id;
    }
  }

  return visibleNodes.at(-1)?.id ?? null;
}

function resolveQuitCloseNodeId(
  snapshot: ReturnType<WorkbenchHostHandle["getSnapshot"]>
): string {
  const focusedNodeId = snapshot.nodeStack.at(-1);
  if (
    focusedNodeId &&
    snapshot.nodes.some((node) => node.id === focusedNodeId)
  ) {
    return focusedNodeId;
  }

  return snapshot.nodes.at(-1)?.id ?? "";
}
