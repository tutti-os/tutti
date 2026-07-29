import type { WorkbenchAction } from "../core/actions.ts";
import {
  createWorkbenchInitialState,
  reduceWorkbenchState
} from "../core/reducer.ts";
import type { WorkbenchState } from "../core/types.ts";
import { createWorkbenchSubscriptionSet } from "./subscribe.ts";
import type { WorkbenchDebugDiagnostics, WorkbenchStore } from "./types.ts";

export function createWorkbenchStore<TData = unknown>(
  initialState: Partial<WorkbenchState<TData>> = {},
  options: {
    debugDiagnostics?: WorkbenchDebugDiagnostics;
    onSurfaceSizeMeasured?: () => void;
  } = {}
): WorkbenchStore<TData> {
  let state = createWorkbenchInitialState(initialState);
  const subscriptions = createWorkbenchSubscriptionSet();

  return {
    getSnapshot() {
      return state;
    },
    subscribe(listener) {
      return subscriptions.subscribe(listener);
    },
    dispatch(action: WorkbenchAction<TData>) {
      const nextState = reduceWorkbenchState(state, action);
      if (nextState === state) {
        notifySurfaceSizeMeasured(action, options);
        return;
      }

      logWorkbenchFrameChanges(action, state, nextState, options);
      state = nextState;
      subscriptions.notify();
      notifySurfaceSizeMeasured(action, options);
    }
  };
}

function notifySurfaceSizeMeasured<TData>(
  action: WorkbenchAction<TData>,
  options: { onSurfaceSizeMeasured?: () => void }
): void {
  if (action.type === "setSurfaceSize") {
    options.onSurfaceSizeMeasured?.();
  }
}

function logWorkbenchFrameChanges<TData>(
  action: WorkbenchAction<TData>,
  previousState: WorkbenchState<TData>,
  nextState: WorkbenchState<TData>,
  options: { debugDiagnostics?: WorkbenchDebugDiagnostics }
): void {
  if (!options.debugDiagnostics?.isEnabled()) {
    return;
  }

  const previousNodesByID = new Map(
    previousState.nodes.map((node) => [node.id, node])
  );
  const changes = nextState.nodes
    .map((node) => {
      const previousNode = previousNodesByID.get(node.id);
      if (!previousNode) {
        return {
          id: node.id,
          kind: "opened",
          nextFrame: node.frame
        };
      }
      if (
        previousNode.frame.x === node.frame.x &&
        previousNode.frame.y === node.frame.y &&
        previousNode.frame.width === node.frame.width &&
        previousNode.frame.height === node.frame.height
      ) {
        return null;
      }
      return {
        id: node.id,
        kind: "frame-changed",
        nextFrame: node.frame,
        previousFrame: previousNode.frame
      };
    })
    .filter((change): change is NonNullable<typeof change> => change !== null);

  if (changes.length === 0) {
    return;
  }

  console.info("[workbench:frame]", {
    action: summarizeWorkbenchAction(action),
    changes,
    nextSurfaceSize: nextState.surfaceSize,
    previousSurfaceSize: previousState.surfaceSize
  });
  void Promise.resolve(
    options.debugDiagnostics.log?.({
      details: {
        action: summarizeWorkbenchAction(action),
        changes,
        nextSurfaceSize: nextState.surfaceSize,
        previousSurfaceSize: previousState.surfaceSize
      },
      event: "frame-changed",
      level: "info",
      source: "workbench-frame"
    })
  ).catch(() => undefined);
}

function summarizeWorkbenchAction<TData>(
  action: WorkbenchAction<TData>
): Record<string, unknown> {
  switch (action.type) {
    case "replaceState":
      return {
        type: action.type,
        nodeCount: action.state.nodes?.length,
        nodeStack: action.state.nodeStack,
        surfaceSize: action.state.surfaceSize
      };
    case "replaceNodes":
      return {
        type: action.type,
        nodeIDs: action.nodes.map((node) => node.id)
      };
    case "openNode":
      return {
        type: action.type,
        frame: action.node.frame,
        nodeID: action.node.id
      };
    case "dragNode":
    case "moveNode":
    case "resizeNode":
      return {
        type: action.type,
        frame: action.frame,
        nodeID: action.nodeID
      };
    case "setSurfaceSize":
      return {
        type: action.type,
        size: action.size
      };
    case "setLayoutConstraints":
      return {
        type: action.type,
        constraints: action.constraints
      };
    case "applyQuickLayout":
      return {
        type: action.type,
        nodeID: action.nodeID,
        target: action.target
      };
    case "applyLayoutPreset":
      return {
        type: action.type,
        nodeIDs: action.nodeIDs,
        preset: action.preset
      };
    case "applyVisibleLayoutPreset":
      return {
        type: action.type,
        preset: action.preset
      };
    case "applySnapTarget":
      return {
        type: action.type,
        nodeID: action.nodeID,
        snapTarget: action.snapTarget
      };
    default:
      return "nodeID" in action
        ? { type: action.type, nodeID: action.nodeID }
        : { type: action.type };
  }
}
