import type {
  WorkbenchHostNodeData,
  WorkbenchMissionControlAdapter
} from "@tutti-os/workbench-surface";
import { MissionControlActivatedReporter } from "../../../analytics/reporters/mission-control-activated/missionControlActivatedReporter.ts";
import { MissionControlDeactivatedReporter } from "../../../analytics/reporters/mission-control-deactivated/missionControlDeactivatedReporter.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";

export type WorkspaceMissionControlTrigger = "button" | "keyboard";

export interface WorkspaceMissionControlOpenRequest {
  nodeIds?: readonly string[];
  trigger?: WorkspaceMissionControlTrigger;
}

export interface WorkspaceMissionControlSnapshot {
  canOpen: boolean;
  isLayoutLocked: boolean;
  isOpen: boolean;
  nodeIds: readonly string[] | null;
  shortcutsEnabled: boolean;
  visibleWindowCount: number;
}

export interface WorkspaceMissionControlController {
  close: () => void;
  getSnapshot: () => WorkspaceMissionControlSnapshot;
  open: (
    request?:
      | WorkspaceMissionControlOpenRequest
      | WorkspaceMissionControlTrigger
  ) => void;
  setAdapter: (
    adapter: WorkbenchMissionControlAdapter<WorkbenchHostNodeData> | null
  ) => void;
  subscribe: (listener: () => void) => () => void;
  unlockLayout: () => void;
}

export interface WorkspaceMissionControlControllerDependencies {
  reporterService?: Pick<IReporterService, "trackEvents">;
  reporterNow?: () => number;
}

export function createWorkspaceMissionControlController(
  dependencies: WorkspaceMissionControlControllerDependencies = {}
): WorkspaceMissionControlController {
  let adapter: WorkbenchMissionControlAdapter<WorkbenchHostNodeData> | null =
    null;
  let unsubscribeAdapter: (() => void) | null = null;
  let activatedAt: number | null = null;
  let isOpen = false;
  let nodeIds: readonly string[] | null = null;
  let snapshot = createSnapshot({ adapter, isOpen, nodeIds });
  const listeners = new Set<() => void>();
  const now = () => dependencies.reporterNow?.() ?? Date.now();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const setOpen = (
    nextIsOpen: boolean,
    nextNodeIds: readonly string[] | null = nextIsOpen ? nodeIds : null
  ) => {
    isOpen = nextIsOpen;
    nodeIds = nextNodeIds;
    const nextSnapshot = createSnapshot({ adapter, isOpen, nodeIds });
    if (isEqualSnapshot(snapshot, nextSnapshot)) {
      return;
    }

    snapshot = nextSnapshot;
    notify();
  };
  const refreshSnapshot = () => {
    const nextIsOpen =
      !adapter || countVisibleNodes(adapter, nodeIds) <= 1 ? false : isOpen;
    if (!nextIsOpen) {
      isOpen = false;
      nodeIds = null;
    }
    const nextSnapshot = createSnapshot({
      adapter,
      isOpen: nextIsOpen,
      nodeIds
    });
    if (isEqualSnapshot(snapshot, nextSnapshot)) {
      return;
    }

    snapshot = nextSnapshot;
    notify();
  };

  return {
    close: () => {
      if (!snapshot.isOpen) {
        return;
      }

      const durationMs =
        activatedAt === null ? 0 : Math.max(0, now() - activatedAt);
      setOpen(false);
      activatedAt = null;
      reportDeactivated(durationMs, dependencies);
    },
    getSnapshot: () => {
      return snapshot;
    },
    open: (request = "button") => {
      const normalizedRequest =
        typeof request === "string" ? { trigger: request } : request;
      const nextNodeIds = normalizedRequest.nodeIds ?? null;
      const nextSnapshot = createSnapshot({
        adapter,
        isOpen: true,
        nodeIds: nextNodeIds
      });
      if (!nextSnapshot.canOpen || isEqualSnapshot(snapshot, nextSnapshot)) {
        return;
      }

      activatedAt = now();
      setOpen(true, nextNodeIds);
      reportActivated(
        {
          trigger: normalizedRequest.trigger ?? "button",
          windowCount: snapshot.visibleWindowCount
        },
        dependencies
      );
    },
    setAdapter: (nextAdapter) => {
      unsubscribeAdapter?.();
      adapter = nextAdapter;
      unsubscribeAdapter = nextAdapter?.subscribe(refreshSnapshot) ?? null;

      if (!adapter) {
        refreshSnapshot();
        return;
      }
      refreshSnapshot();
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    unlockLayout: () => {
      adapter?.releaseLockedLayout();
    }
  };
}

function reportActivated(
  params: {
    trigger: WorkspaceMissionControlTrigger;
    windowCount: number;
  },
  dependencies: WorkspaceMissionControlControllerDependencies
): void {
  if (!dependencies.reporterService) {
    return;
  }

  void new MissionControlActivatedReporter(params, {
    reporterService: dependencies.reporterService,
    now: dependencies.reporterNow
  }).report();
}

function reportDeactivated(
  durationMs: number,
  dependencies: WorkspaceMissionControlControllerDependencies
): void {
  if (!dependencies.reporterService) {
    return;
  }

  void new MissionControlDeactivatedReporter(
    {
      durationMs
    },
    {
      reporterService: dependencies.reporterService,
      now: dependencies.reporterNow
    }
  ).report();
}

function createSnapshot({
  adapter,
  isOpen,
  nodeIds
}: {
  adapter: WorkbenchMissionControlAdapter<WorkbenchHostNodeData> | null;
  isOpen: boolean;
  nodeIds: readonly string[] | null;
}): WorkspaceMissionControlSnapshot {
  const visibleWindowCount = countVisibleNodes(adapter, nodeIds);
  const canOpen = visibleWindowCount > 1;
  return {
    canOpen,
    isLayoutLocked: adapter?.getSnapshot().isLayoutLocked ?? false,
    isOpen,
    nodeIds,
    shortcutsEnabled: !isOpen,
    visibleWindowCount
  };
}

function countVisibleNodes(
  adapter: WorkbenchMissionControlAdapter<WorkbenchHostNodeData> | null,
  nodeIds: readonly string[] | null
): number {
  const visibleNodes = adapter?.getSnapshot().visibleNodes ?? [];
  if (nodeIds === null) {
    return visibleNodes.length;
  }
  const nodeIdSet = new Set(nodeIds);
  return visibleNodes.filter((node) => nodeIdSet.has(node.id)).length;
}

function isEqualSnapshot(
  left: WorkspaceMissionControlSnapshot,
  right: WorkspaceMissionControlSnapshot
): boolean {
  return (
    left.canOpen === right.canOpen &&
    left.isLayoutLocked === right.isLayoutLocked &&
    left.isOpen === right.isOpen &&
    areEqualNodeIds(left.nodeIds, right.nodeIds) &&
    left.shortcutsEnabled === right.shortcutsEnabled &&
    left.visibleWindowCount === right.visibleWindowCount
  );
}

function areEqualNodeIds(
  left: readonly string[] | null,
  right: readonly string[] | null
): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null || left.length !== right.length) {
    return false;
  }
  return left.every((nodeId, index) => nodeId === right[index]);
}
