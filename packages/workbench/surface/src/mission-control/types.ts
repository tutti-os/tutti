import type {
  WorkbenchLayoutConstraints,
  WorkbenchLayoutPreset,
  WorkbenchNode,
  WorkbenchSize
} from "../core/types.ts";

export interface WorkbenchMissionControlSnapshot<TData = unknown> {
  isLayoutLocked: boolean;
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
  getSnapshot(): WorkbenchMissionControlSnapshot<TData>;
  releaseLockedLayout(): void;
  subscribe(listener: () => void): () => void;
}
