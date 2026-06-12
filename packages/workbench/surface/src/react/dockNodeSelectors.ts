import type { WorkbenchNode, WorkbenchState } from "../core/types.ts";

export function createWorkbenchDockNodesSelector<TData>(): (
  state: WorkbenchState<TData>
) => readonly WorkbenchNode<TData>[] {
  let previousNodes: readonly WorkbenchNode<TData>[] | null = null;

  return (state) => {
    if (
      previousNodes &&
      areWorkbenchDockNodesEqual(previousNodes, state.nodes)
    ) {
      return previousNodes;
    }

    previousNodes = state.nodes;
    return state.nodes;
  };
}

function areWorkbenchDockNodesEqual<TData>(
  previousNodes: readonly WorkbenchNode<TData>[],
  nextNodes: readonly WorkbenchNode<TData>[]
): boolean {
  if (previousNodes.length !== nextNodes.length) {
    return false;
  }

  return previousNodes.every((previousNode, index) => {
    const nextNode = nextNodes[index];
    return (
      nextNode !== undefined &&
      previousNode.id === nextNode.id &&
      previousNode.kind === nextNode.kind &&
      previousNode.title === nextNode.title &&
      previousNode.displayMode === nextNode.displayMode &&
      previousNode.isMinimized === nextNode.isMinimized &&
      previousNode.minimizedAtUnixMs === nextNode.minimizedAtUnixMs &&
      previousNode.frame.width === nextNode.frame.width &&
      previousNode.frame.height === nextNode.frame.height &&
      previousNode.data === nextNode.data
    );
  });
}
