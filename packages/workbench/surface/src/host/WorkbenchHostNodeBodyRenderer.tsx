import { memo, type ReactNode } from "react";
import type {
  WorkbenchHostNodeBodyContext,
  WorkbenchHostNodeDefinition
} from "./types.ts";

interface WorkbenchHostNodeBodyRendererProps {
  context: WorkbenchHostNodeBodyContext;
  definition: WorkbenchHostNodeDefinition;
}

function WorkbenchHostNodeBodyRenderer(
  input: WorkbenchHostNodeBodyRendererProps
): ReactNode {
  return input.definition.renderBody(input.context);
}

function areWorkbenchHostNodeBodyRendererPropsEqual(
  previous: WorkbenchHostNodeBodyRendererProps,
  next: WorkbenchHostNodeBodyRendererProps
): boolean {
  const previousContext = previous.context;
  const nextContext = next.context;
  if (
    previous.definition !== next.definition ||
    previousContext.activation !== nextContext.activation ||
    previousContext.displayMode !== nextContext.displayMode ||
    previousContext.externalNodeState !== nextContext.externalNodeState ||
    previousContext.externalWorkspaceState !==
      nextContext.externalWorkspaceState ||
    previousContext.host !== nextContext.host ||
    previousContext.instanceId !== nextContext.instanceId ||
    previousContext.instanceKey !== nextContext.instanceKey ||
    previousContext.isDragging !== nextContext.isDragging ||
    previousContext.isFocused !== nextContext.isFocused ||
    previousContext.isResizing !== nextContext.isResizing ||
    previousContext.isVisible !== nextContext.isVisible ||
    previousContext.isPresentationVisible !==
      nextContext.isPresentationVisible ||
    previousContext.presentationMode !== nextContext.presentationMode ||
    !areWorkbenchOptionalSizesEqual(
      previousContext.previewViewport,
      nextContext.previewViewport
    )
  ) {
    return false;
  }

  const previousNode = previousContext.node;
  const nextNode = nextContext.node;
  if (
    previousNode.id !== nextNode.id ||
    previousNode.kind !== nextNode.kind ||
    previousNode.title !== nextNode.title ||
    previousNode.displayMode !== nextNode.displayMode ||
    previousNode.restoreFrame !== nextNode.restoreFrame ||
    previousNode.isMinimized !== nextNode.isMinimized ||
    previousNode.minimizedAtUnixMs !== nextNode.minimizedAtUnixMs ||
    previousNode.sizeConstraints !== nextNode.sizeConstraints ||
    previousNode.data !== nextNode.data
  ) {
    return false;
  }

  if (nextContext.isDragging || nextContext.isResizing) {
    return (
      previousNode.frame.width === nextNode.frame.width &&
      previousNode.frame.height === nextNode.frame.height
    );
  }

  return areWorkbenchFramesEqual(previousNode.frame, nextNode.frame);
}

function areWorkbenchFramesEqual(
  previous: WorkbenchHostNodeBodyContext["node"]["frame"],
  next: WorkbenchHostNodeBodyContext["node"]["frame"]
): boolean {
  return (
    previous.x === next.x &&
    previous.y === next.y &&
    previous.width === next.width &&
    previous.height === next.height
  );
}

function areWorkbenchOptionalSizesEqual(
  previous: WorkbenchHostNodeBodyContext["previewViewport"],
  next: WorkbenchHostNodeBodyContext["previewViewport"]
): boolean {
  return (
    previous === next ||
    (previous !== undefined &&
      next !== undefined &&
      previous.width === next.width &&
      previous.height === next.height)
  );
}

export const MemoizedWorkbenchHostNodeBodyRenderer = memo(
  WorkbenchHostNodeBodyRenderer,
  areWorkbenchHostNodeBodyRendererPropsEqual
);
