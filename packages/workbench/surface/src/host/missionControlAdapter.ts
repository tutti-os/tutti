import { selectVisibleWorkbenchNodes } from "../core/selectors.ts";
import { createDerivedSnapshotGetter } from "../store/createDerivedSnapshotGetter.ts";
import type { WorkbenchController } from "../store/types.ts";
import type { WorkbenchMissionControlAdapter } from "../mission-control/types.ts";
import { workbenchFocusInputActivationType } from "./activations.ts";
import type {
  WorkbenchHostActivationTarget,
  WorkbenchHostNodeData
} from "./types.ts";

export function createWorkbenchHostMissionControlAdapter(input: {
  activateNode?: (
    target: WorkbenchHostActivationTarget,
    activation: {
      payload?: unknown;
      type: string;
    }
  ) => void;
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
    focusNode(nodeId) {
      if (input.activateNode) {
        input.activateNode(
          { nodeId },
          { type: workbenchFocusInputActivationType }
        );
        return;
      }
      input.controller.commands.focusNode(nodeId);
    },
    getSnapshot,
    subscribe(listener) {
      return input.controller.subscribe(listener);
    }
  };
}
