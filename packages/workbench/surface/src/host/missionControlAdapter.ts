import { selectVisibleWorkbenchNodes } from "../core/selectors.ts";
import { createDerivedSnapshotGetter } from "../store/createDerivedSnapshotGetter.ts";
import type { WorkbenchController } from "../store/types.ts";
import type { WorkbenchMissionControlAdapter } from "../mission-control/types.ts";
import type { WorkbenchHostNodeData } from "./types.ts";

export function createWorkbenchHostMissionControlAdapter(input: {
  controller: WorkbenchController<WorkbenchHostNodeData>;
}): WorkbenchMissionControlAdapter<WorkbenchHostNodeData> {
  const getSnapshot = createDerivedSnapshotGetter<
    ReturnType<WorkbenchController<WorkbenchHostNodeData>["getSnapshot"]>,
    ReturnType<
      WorkbenchMissionControlAdapter<WorkbenchHostNodeData>["getSnapshot"]
    >
  >({
    deriveSnapshot(controllerSnapshot) {
      return {
        isLayoutLocked: controllerSnapshot.lockedLayout !== null,
        layoutConstraints: controllerSnapshot.layoutConstraints,
        surfaceSize: controllerSnapshot.surfaceSize,
        visibleNodes: selectVisibleWorkbenchNodes(controllerSnapshot)
      };
    },
    getSourceSnapshot() {
      return input.controller.getSnapshot();
    }
  });

  return {
    applyLayoutPreset(nodeIds, preset, lock) {
      input.controller.commands.applyLayoutPreset(nodeIds, preset, lock);
    },
    getSnapshot,
    releaseLockedLayout() {
      input.controller.commands.releaseLockedLayout();
    },
    subscribe(listener) {
      return input.controller.subscribe(listener);
    }
  };
}
