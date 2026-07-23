import type { WorkbenchSnapshotLayoutBasisV1 } from "@tutti-os/workbench-snapshot";
import {
  clampWorkbenchRect,
  denormalizeWorkbenchFrameFromRect,
  getWorkbenchSafeLayoutRect,
  normalizeWorkbenchFrameToRect
} from "./geometry.ts";
import type {
  WorkbenchFrame,
  WorkbenchLayoutConstraints,
  WorkbenchNodeSizeConstraints,
  WorkbenchSize
} from "./types.ts";

export function restoreWorkbenchFrameToLayout(input: {
  frame: WorkbenchFrame;
  sourceLayoutBasis?: WorkbenchSnapshotLayoutBasisV1 | null;
  targetLayoutConstraints: WorkbenchLayoutConstraints;
  targetSurfaceSize: WorkbenchSize;
  sizeConstraints?: WorkbenchNodeSizeConstraints | null;
}): WorkbenchFrame {
  const sourceLayoutBasis = input.sourceLayoutBasis;
  if (!sourceLayoutBasis) {
    return normalizeRestoredFrame(
      clampWorkbenchRect(
        input.frame,
        input.targetSurfaceSize,
        input.targetLayoutConstraints,
        input.sizeConstraints
      )
    );
  }

  const sourceLayoutRect = getWorkbenchSafeLayoutRect(
    sourceLayoutBasis.surfaceSize,
    sourceLayoutBasis.layoutConstraints
  );
  const targetLayoutRect = getWorkbenchSafeLayoutRect(
    input.targetSurfaceSize,
    input.targetLayoutConstraints
  );
  const normalizedFrame = normalizeWorkbenchFrameToRect(
    input.frame,
    sourceLayoutRect
  );
  const restoredFrame = denormalizeWorkbenchFrameFromRect(
    normalizedFrame,
    targetLayoutRect
  );

  return normalizeRestoredFrame(
    clampWorkbenchRect(
      restoredFrame,
      input.targetSurfaceSize,
      input.targetLayoutConstraints,
      input.sizeConstraints
    )
  );
}

function normalizeRestoredFrame(frame: WorkbenchFrame): WorkbenchFrame {
  return {
    x: normalizeCoordinate(frame.x),
    y: normalizeCoordinate(frame.y),
    width: normalizeCoordinate(frame.width),
    height: normalizeCoordinate(frame.height)
  };
}

function normalizeCoordinate(value: number): number {
  const normalized = Number(value.toFixed(3));
  return Object.is(normalized, -0) ? 0 : normalized;
}
