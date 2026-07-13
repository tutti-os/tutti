import type {
  WorkbenchLayoutConstraints,
  WorkbenchLayoutPreset,
  WorkbenchNode,
  WorkbenchSize
} from "../core/types.ts";

export type WorkbenchMissionControlMode = "activate" | "layout";

export interface WorkbenchMissionControlSnapshot<TData = unknown> {
  layoutConstraints: WorkbenchLayoutConstraints;
  surfaceSize: WorkbenchSize;
  visibleNodes: readonly WorkbenchNode<TData>[];
}

export interface WorkbenchMissionControlAdapter<TData = unknown> {
  applyLayoutPreset(
    nodeIds: string[],
    preset: WorkbenchLayoutPreset,
    lock?: boolean
  ): void;
  focusNode(nodeId: string): void;
  getSnapshot(): WorkbenchMissionControlSnapshot<TData>;
  subscribe(listener: () => void): () => void;
}
