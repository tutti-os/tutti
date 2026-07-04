import { clampWorkbenchRect } from "./geometry.ts";
import {
  defaultWorkbenchLayoutConstraints,
  type WorkbenchLayoutConstraints,
  type WorkbenchFrame,
  type WorkbenchNode,
  type WorkbenchNodeSizeConstraints,
  type WorkbenchSize
} from "./types.ts";

export const WORKBENCH_WINDOW_CASCADE_OFFSET = 28;
const WORKBENCH_WINDOW_CASCADE_FALLBACK_LIMIT = 12;
const WORKBENCH_WINDOW_CASCADE_POSITION_TOLERANCE = 4;

interface WorkbenchCascadedRectInput<TData> {
  cascadeOffset?: { x: number; y: number };
  constraints?: WorkbenchLayoutConstraints;
  currentNodeStack: readonly string[];
  existingNodes: readonly WorkbenchNode<TData>[];
  preferredFrame: WorkbenchFrame;
  sizeConstraints?: WorkbenchNodeSizeConstraints | null;
  surfaceSize: WorkbenchSize;
}

export function createWorkbenchInitialRect(
  index: number,
  surfaceSize: WorkbenchSize,
  constraints: WorkbenchLayoutConstraints = defaultWorkbenchLayoutConstraints,
  sizeConstraints?: WorkbenchNodeSizeConstraints | null
): WorkbenchFrame {
  const frameOrigin = {
    x: constraints.safeArea.left + constraints.surfacePadding,
    y: constraints.safeArea.top + constraints.surfacePadding
  };
  const baseWidth = Math.min(760, Math.max(360, surfaceSize.width * 0.62));
  const baseHeight = Math.min(520, Math.max(260, surfaceSize.height * 0.62));
  const offset = (index % 8) * WORKBENCH_WINDOW_CASCADE_OFFSET;

  return clampWorkbenchRect(
    {
      x: frameOrigin.x + offset,
      y: frameOrigin.y + offset,
      width: baseWidth,
      height: baseHeight
    },
    surfaceSize,
    constraints,
    sizeConstraints
  );
}

export function resolveWorkbenchCascadedRect<TData>(
  input: WorkbenchCascadedRectInput<TData>
): WorkbenchFrame {
  const hasCustomCascadeOffset = input.cascadeOffset !== undefined;
  const cascadeOffset = input.cascadeOffset ?? {
    x: WORKBENCH_WINDOW_CASCADE_OFFSET,
    y: WORKBENCH_WINDOW_CASCADE_OFFSET
  };
  const activeNode =
    input.existingNodes.find(
      (node) => node.id === input.currentNodeStack.at(-1)
    ) ?? input.existingNodes.at(-1);

  if (!activeNode) {
    return clampWorkbenchRect(
      input.preferredFrame,
      input.surfaceSize,
      input.constraints,
      input.sizeConstraints
    );
  }

  const preferredCandidate = createWorkbenchCascadeCandidate({
    input,
    x: activeNode.frame.x + cascadeOffset.x,
    y: activeNode.frame.y + cascadeOffset.y
  });
  if (
    (!hasCustomCascadeOffset || input.existingNodes.length <= 1) &&
    !workbenchCascadeCandidateMatchesExisting(preferredCandidate, input)
  ) {
    return preferredCandidate;
  }

  const candidateOrigins = [
    {
      x: activeNode.frame.x + cascadeOffset.x,
      y: activeNode.frame.y + cascadeOffset.y
    },
    {
      x: activeNode.frame.x - cascadeOffset.x,
      y: activeNode.frame.y + cascadeOffset.y
    },
    {
      x: activeNode.frame.x + cascadeOffset.x,
      y: activeNode.frame.y - cascadeOffset.y
    },
    {
      x: activeNode.frame.x - cascadeOffset.x,
      y: activeNode.frame.y - cascadeOffset.y
    }
  ];

  for (
    let index = 1;
    index <= WORKBENCH_WINDOW_CASCADE_FALLBACK_LIMIT;
    index += 1
  ) {
    candidateOrigins.push(
      {
        x: input.preferredFrame.x + cascadeOffset.x * index,
        y: input.preferredFrame.y + cascadeOffset.y * index
      },
      {
        x: input.preferredFrame.x - cascadeOffset.x * index,
        y: input.preferredFrame.y + cascadeOffset.y * index
      },
      {
        x: input.preferredFrame.x + cascadeOffset.x * index,
        y: input.preferredFrame.y - cascadeOffset.y * index
      },
      {
        x: input.preferredFrame.x - cascadeOffset.x * index,
        y: input.preferredFrame.y - cascadeOffset.y * index
      }
    );
  }

  return resolveBestWorkbenchCascadeCandidate({
    candidateOrigins,
    fallbackFrame: preferredCandidate,
    input
  });
}

function createWorkbenchCascadeCandidate<TData>(input: {
  input: WorkbenchCascadedRectInput<TData>;
  x: number;
  y: number;
}): WorkbenchFrame {
  return clampWorkbenchRect(
    {
      x: input.x,
      y: input.y,
      width: input.input.preferredFrame.width,
      height: input.input.preferredFrame.height
    },
    input.input.surfaceSize,
    input.input.constraints,
    input.input.sizeConstraints
  );
}

function workbenchCascadeCandidateMatchesExisting<TData>(
  candidate: WorkbenchFrame,
  input: WorkbenchCascadedRectInput<TData>
): boolean {
  return input.existingNodes.some((node) => {
    return (
      Math.abs(node.frame.x - candidate.x) <=
        WORKBENCH_WINDOW_CASCADE_POSITION_TOLERANCE &&
      Math.abs(node.frame.y - candidate.y) <=
        WORKBENCH_WINDOW_CASCADE_POSITION_TOLERANCE
    );
  });
}

function resolveBestWorkbenchCascadeCandidate<TData>(input: {
  candidateOrigins: readonly Pick<WorkbenchFrame, "x" | "y">[];
  fallbackFrame: WorkbenchFrame;
  input: WorkbenchCascadedRectInput<TData>;
}): WorkbenchFrame {
  let bestFrame: WorkbenchFrame | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  for (const candidate of input.candidateOrigins) {
    const frame = createWorkbenchCascadeCandidate({
      input: input.input,
      x: candidate.x,
      y: candidate.y
    });
    const key = `${frame.x}:${frame.y}:${frame.width}:${frame.height}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const score = scoreWorkbenchCascadeCandidate(frame, input.input);
    if (score < bestScore) {
      bestFrame = frame;
      bestScore = score;
    }
  }

  return bestFrame ?? input.fallbackFrame;
}

function scoreWorkbenchCascadeCandidate<TData>(
  candidate: WorkbenchFrame,
  input: WorkbenchCascadedRectInput<TData>
): number {
  const overlapArea = input.existingNodes.reduce((total, node) => {
    return total + workbenchFrameIntersectionArea(candidate, node.frame);
  }, 0);
  const positionCollisionPenalty = workbenchCascadeCandidateMatchesExisting(
    candidate,
    input
  )
    ? candidate.width * candidate.height
    : 0;

  return overlapArea + positionCollisionPenalty;
}

function workbenchFrameIntersectionArea(
  a: WorkbenchFrame,
  b: WorkbenchFrame
): number {
  const width = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  );
  const height = Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  );
  return width * height;
}

export function placeWorkbenchNode<TData>(
  node: Omit<WorkbenchNode<TData>, "frame"> & { frame?: WorkbenchFrame },
  index: number,
  surfaceSize: WorkbenchSize
): WorkbenchNode<TData> {
  return {
    ...node,
    frame: node.frame ?? createWorkbenchInitialRect(index, surfaceSize)
  };
}
