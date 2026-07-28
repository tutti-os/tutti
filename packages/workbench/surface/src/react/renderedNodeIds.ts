import type { WorkbenchNode, WorkbenchState } from "../core/types.ts";
import type {
  WorkbenchKeepMinimizedNodeMounted,
  WorkbenchResolveWindowSurfaceLayer
} from "./types.ts";

const emptyNodeIDs: readonly string[] = [];

export interface WorkbenchNodeLayerNodeIDs {
  defaultNodeIDs: readonly string[];
  dialogPopoverNodeIDs: readonly string[];
}

export function createRenderedWorkbenchNodeIDsSelector<TData>(
  shouldKeepMinimizedNodeMounted:
    | WorkbenchKeepMinimizedNodeMounted<TData>
    | undefined = undefined
): (state: WorkbenchState<TData>) => readonly string[] {
  let previousIDs: readonly string[] | null = null;

  return (state) => {
    const nextIDs = state.nodes
      .filter((node) =>
        shouldRenderWorkbenchNode(node, shouldKeepMinimizedNodeMounted)
      )
      .map((node) => node.id);

    if (previousIDs && stringArraysEqual(previousIDs, nextIDs)) {
      return previousIDs;
    }

    previousIDs = nextIDs;
    return nextIDs;
  };
}

export function createWorkbenchNodeLayerNodeIDsSelector<TData>({
  missionControl,
  resolveWindowSurfaceLayer,
  shouldKeepMinimizedNodeMounted
}: {
  missionControl: boolean;
  resolveWindowSurfaceLayer?: WorkbenchResolveWindowSurfaceLayer<TData>;
  shouldKeepMinimizedNodeMounted?: WorkbenchKeepMinimizedNodeMounted<TData>;
}): (state: WorkbenchState<TData>) => WorkbenchNodeLayerNodeIDs {
  const selectRenderedNodeIDs = createRenderedWorkbenchNodeIDsSelector(
    shouldKeepMinimizedNodeMounted
  );
  let previousSelection: WorkbenchNodeLayerNodeIDs | null = null;

  return (state) => {
    const renderedNodeIDs = selectRenderedNodeIDs(state);
    let nextDefaultNodeIDs: readonly string[] = renderedNodeIDs;
    let nextDialogPopoverNodeIDs: readonly string[] = emptyNodeIDs;

    if (resolveWindowSurfaceLayer && !missionControl) {
      const nodeByID = new Map(state.nodes.map((node) => [node.id, node]));
      const defaultNodeIDs: string[] = [];
      const dialogPopoverNodeIDs: string[] = [];

      for (const nodeID of renderedNodeIDs) {
        const node = nodeByID.get(nodeID);
        if (node && resolveWindowSurfaceLayer({ node }) === "dialog-popover") {
          dialogPopoverNodeIDs.push(nodeID);
        } else {
          defaultNodeIDs.push(nodeID);
        }
      }

      nextDefaultNodeIDs = preserveStringArrayIdentity(
        previousSelection?.defaultNodeIDs,
        defaultNodeIDs
      );
      nextDialogPopoverNodeIDs = preserveStringArrayIdentity(
        previousSelection?.dialogPopoverNodeIDs,
        dialogPopoverNodeIDs
      );
    }

    if (
      previousSelection?.defaultNodeIDs === nextDefaultNodeIDs &&
      previousSelection.dialogPopoverNodeIDs === nextDialogPopoverNodeIDs
    ) {
      return previousSelection;
    }

    previousSelection = {
      defaultNodeIDs: nextDefaultNodeIDs,
      dialogPopoverNodeIDs: nextDialogPopoverNodeIDs
    };
    return previousSelection;
  };
}

function shouldRenderWorkbenchNode<TData>(
  node: WorkbenchNode<TData>,
  shouldKeepMinimizedNodeMounted:
    | WorkbenchKeepMinimizedNodeMounted<TData>
    | undefined
): boolean {
  return !node.isMinimized || shouldKeepMinimizedNodeMounted?.(node) === true;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function preserveStringArrayIdentity(
  previous: readonly string[] | undefined,
  next: readonly string[]
): readonly string[] {
  return previous && stringArraysEqual(previous, next) ? previous : next;
}
