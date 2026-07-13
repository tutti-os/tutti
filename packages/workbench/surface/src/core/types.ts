import type {
  WorkbenchFrame as WorkbenchSnapshotFrame,
  WorkbenchSnapshotDisplayModeV1
} from "@tutti-os/workbench-snapshot";

export interface WorkbenchSize {
  width: number;
  height: number;
}

export type WorkbenchFrame = WorkbenchSnapshotFrame;

export interface WorkbenchSafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type WorkbenchDisplayMode = WorkbenchSnapshotDisplayModeV1;
export type WorkbenchSnapTarget =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | null;
export type WorkbenchQuickLayoutTarget =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "center"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";
export type WorkbenchLayoutPreset =
  | { kind: "balanced" }
  | { kind: "row" }
  | { kind: "column" };

/**
 * A layout preset that stays "locked" onto a set of nodes: whenever the surface
 * is resized the layout is re-applied to these nodes so they keep scaling
 * proportionally. Dragging a locked node swaps grid slots and resizing a
 * locked node moves the shared grid dividers; the lock is only released
 * explicitly (titlebar button) or by programmatic moves.
 */
export interface WorkbenchLockedLayout {
  preset: WorkbenchLayoutPreset;
  nodeIDs: string[];
  /**
   * Custom slot geometry created when the user resizes a locked window,
   * normalized (0..1) against the safe layout rect. When present it takes
   * precedence over the preset frames; when absent the slots derive from the
   * preset.
   */
  normalizedFrames?: Record<string, WorkbenchFrame>;
}
export type WorkbenchResizeHandle =
  | "north"
  | "east"
  | "south"
  | "west"
  | "north-east"
  | "north-west"
  | "south-east"
  | "south-west";

export interface WorkbenchNode<TData = unknown> {
  id: string;
  kind: string;
  title: string;
  frame: WorkbenchFrame;
  displayMode: WorkbenchDisplayMode;
  restoreFrame: WorkbenchFrame | null;
  isMinimized: boolean;
  minimizedAtUnixMs?: number | null;
  sizeConstraints?: WorkbenchNodeSizeConstraints | null;
  data: TData;
}

export interface WorkbenchNodeSizeConstraints {
  minWidth?: number;
  minHeight?: number;
}

export interface WorkbenchState<TData = unknown> {
  nodes: WorkbenchNode<TData>[];
  nodeStack: string[];
  activeDragNodeId: string | null;
  activeResizeNodeId: string | null;
  activeSnapTarget: WorkbenchSnapTarget;
  surfaceSize: WorkbenchSize;
  layoutConstraints: WorkbenchLayoutConstraints;
  lockedLayout: WorkbenchLockedLayout | null;
}

export interface WorkbenchLayoutConstraints {
  minWidth: number;
  minHeight: number;
  surfacePadding: number;
  safeArea: WorkbenchSafeArea;
}

export interface WorkbenchLayoutConstraintsInput extends Partial<
  Omit<WorkbenchLayoutConstraints, "safeArea">
> {
  safeArea?: Partial<WorkbenchSafeArea>;
}

export const defaultWorkbenchSafeArea: WorkbenchSafeArea = {
  top: 52,
  right: 0,
  bottom: 88,
  left: 0
};

export const defaultWorkbenchLayoutConstraints: WorkbenchLayoutConstraints = {
  minWidth: 280,
  minHeight: 160,
  surfacePadding: 0,
  safeArea: defaultWorkbenchSafeArea
};

export const defaultWorkbenchSurfaceSize: WorkbenchSize = {
  width: 1024,
  height: 720
};
