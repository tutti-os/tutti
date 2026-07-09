import type {
  WorkbenchFrame,
  WorkbenchLayoutPreset,
  WorkbenchNode,
  WorkbenchNodeSizeConstraints,
  WorkbenchQuickLayoutTarget,
  WorkbenchLayoutConstraintsInput,
  WorkbenchSize,
  WorkbenchSnapTarget,
  WorkbenchState
} from "../core/types.ts";
import type { WorkbenchStore } from "./types.ts";

export interface WorkbenchCommands<TData = unknown> {
  replaceState(state: Partial<WorkbenchState<TData>>): void;
  replaceNodes(nodes: WorkbenchNode<TData>[]): void;
  openNode(node: WorkbenchNode<TData>): void;
  closeNode(nodeID: string): void;
  focusNode(nodeID: string): void;
  minimizeNode(nodeID: string): void;
  restoreNode(nodeID: string): void;
  enterFullscreen(nodeID: string): void;
  exitFullscreen(nodeID: string): void;
  applyQuickLayout(nodeID: string, target: WorkbenchQuickLayoutTarget): void;
  applyLayoutPreset(
    nodeIDs: string[],
    preset: WorkbenchLayoutPreset,
    lock?: boolean
  ): void;
  applyVisibleLayoutPreset(preset: WorkbenchLayoutPreset): void;
  settleLockedDrag(nodeID: string): void;
  moveLockedNode(
    nodeID: string,
    direction: "left" | "right" | "up" | "down"
  ): void;
  releaseLockedLayout(): void;
  applyActiveSnapTarget(nodeID: string): void;
  applySnapTarget(nodeID: string, snapTarget: WorkbenchSnapTarget): void;
  dragNode(nodeID: string, frame: WorkbenchFrame): void;
  moveNode(nodeID: string, frame: WorkbenchFrame): void;
  resizeNode(nodeID: string, frame: WorkbenchFrame): void;
  setActiveDragNode(nodeID: string | null): void;
  setActiveResizeNode(nodeID: string | null): void;
  setActiveSnapTarget(snapTarget: WorkbenchSnapTarget): void;
  setSurfaceSize(size: WorkbenchSize): void;
  setLayoutConstraints(constraints: WorkbenchLayoutConstraintsInput): void;
  setNodeSizeConstraints(
    nodeID: string,
    sizeConstraints: WorkbenchNodeSizeConstraints | null
  ): void;
}

export function createWorkbenchCommands<TData>(
  store: WorkbenchStore<TData>
): WorkbenchCommands<TData> {
  return {
    replaceState(state) {
      store.dispatch({ type: "replaceState", state });
    },
    replaceNodes(nodes) {
      store.dispatch({ type: "replaceNodes", nodes });
    },
    openNode(node) {
      store.dispatch({ type: "openNode", node });
    },
    closeNode(nodeID) {
      store.dispatch({ type: "closeNode", nodeID });
    },
    focusNode(nodeID) {
      store.dispatch({ type: "focusNode", nodeID });
    },
    minimizeNode(nodeID) {
      store.dispatch({ type: "minimizeNode", nodeID });
    },
    restoreNode(nodeID) {
      store.dispatch({ type: "restoreNode", nodeID });
    },
    enterFullscreen(nodeID) {
      store.dispatch({ type: "enterFullscreen", nodeID });
    },
    exitFullscreen(nodeID) {
      store.dispatch({ type: "exitFullscreen", nodeID });
    },
    applyQuickLayout(nodeID, target) {
      store.dispatch({ type: "applyQuickLayout", nodeID, target });
    },
    applyLayoutPreset(nodeIDs, preset, lock) {
      store.dispatch({ type: "applyLayoutPreset", nodeIDs, preset, lock });
    },
    applyVisibleLayoutPreset(preset) {
      store.dispatch({ type: "applyVisibleLayoutPreset", preset });
    },
    settleLockedDrag(nodeID) {
      store.dispatch({ type: "settleLockedDrag", nodeID });
    },
    moveLockedNode(nodeID, direction) {
      store.dispatch({ type: "moveLockedNode", nodeID, direction });
    },
    releaseLockedLayout() {
      store.dispatch({ type: "releaseLockedLayout" });
    },
    applyActiveSnapTarget(nodeID) {
      store.dispatch({ type: "applyActiveSnapTarget", nodeID });
    },
    applySnapTarget(nodeID, snapTarget) {
      store.dispatch({ type: "applySnapTarget", nodeID, snapTarget });
    },
    dragNode(nodeID, frame) {
      store.dispatch({ type: "dragNode", nodeID, frame });
    },
    moveNode(nodeID, frame) {
      store.dispatch({ type: "moveNode", nodeID, frame });
    },
    resizeNode(nodeID, frame) {
      store.dispatch({ type: "resizeNode", nodeID, frame });
    },
    setActiveDragNode(nodeID) {
      store.dispatch({ type: "setActiveDragNode", nodeID });
    },
    setActiveResizeNode(nodeID) {
      store.dispatch({ type: "setActiveResizeNode", nodeID });
    },
    setActiveSnapTarget(snapTarget) {
      store.dispatch({ type: "setActiveSnapTarget", snapTarget });
    },
    setSurfaceSize(size) {
      store.dispatch({ type: "setSurfaceSize", size });
    },
    setLayoutConstraints(constraints) {
      store.dispatch({ type: "setLayoutConstraints", constraints });
    },
    setNodeSizeConstraints(nodeID, sizeConstraints) {
      store.dispatch({
        type: "setNodeSizeConstraints",
        nodeID,
        sizeConstraints
      });
    }
  };
}
