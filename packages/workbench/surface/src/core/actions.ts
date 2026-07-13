import type {
  WorkbenchFrame,
  WorkbenchLayoutPreset,
  WorkbenchLayoutConstraintsInput,
  WorkbenchNode,
  WorkbenchNodeSizeConstraints,
  WorkbenchQuickLayoutTarget,
  WorkbenchSize,
  WorkbenchSnapTarget,
  WorkbenchState
} from "./types.ts";

export type WorkbenchAction<TData = unknown> =
  | { type: "replaceState"; state: Partial<WorkbenchState<TData>> }
  | { type: "replaceNodes"; nodes: WorkbenchNode<TData>[] }
  | { type: "openNode"; node: WorkbenchNode<TData> }
  | { type: "closeNode"; nodeID: string }
  | { type: "focusNode"; nodeID: string }
  | { type: "minimizeNode"; nodeID: string }
  | { type: "restoreNode"; nodeID: string }
  | { type: "enterFullscreen"; nodeID: string }
  | { type: "exitFullscreen"; nodeID: string }
  | {
      type: "applyQuickLayout";
      nodeID: string;
      target: WorkbenchQuickLayoutTarget;
    }
  | {
      type: "applyLayoutPreset";
      nodeIDs: string[];
      preset: WorkbenchLayoutPreset;
      /**
       * When true, remember this preset + node set so it is re-applied on every
       * surface resize (proportional scaling) until the user manually moves a
       * node. Defaults to a one-off arrangement.
       */
      lock?: boolean;
    }
  | {
      type: "applyVisibleLayoutPreset";
      preset: WorkbenchLayoutPreset;
    }
  | {
      /**
       * Ends a drag of a node that belongs to the locked layout: if the node
       * was dropped over another locked node's slot the two swap slots,
       * otherwise the node snaps back to its own slot.
       */
      type: "settleLockedDrag";
      nodeID: string;
    }
  | {
      /**
       * Swaps a locked node with its nearest neighbor slot in the given
       * direction (window snapping shortcuts while a layout is locked).
       */
      type: "moveLockedNode";
      nodeID: string;
      direction: "left" | "right" | "up" | "down";
    }
  | { type: "releaseLockedLayout" }
  | { type: "applyActiveSnapTarget"; nodeID: string }
  | {
      type: "applySnapTarget";
      nodeID: string;
      snapTarget: WorkbenchSnapTarget;
    }
  | { type: "dragNode"; nodeID: string; frame: WorkbenchFrame }
  | { type: "moveNode"; nodeID: string; frame: WorkbenchFrame }
  | { type: "resizeNode"; nodeID: string; frame: WorkbenchFrame }
  | { type: "setActiveDragNode"; nodeID: string | null }
  | { type: "setActiveResizeNode"; nodeID: string | null }
  | { type: "setActiveSnapTarget"; snapTarget: WorkbenchSnapTarget }
  | { type: "setSurfaceSize"; size: WorkbenchSize }
  | {
      type: "setLayoutConstraints";
      constraints: WorkbenchLayoutConstraintsInput;
    }
  | {
      type: "setNodeSizeConstraints";
      nodeID: string;
      sizeConstraints: WorkbenchNodeSizeConstraints | null;
    };
