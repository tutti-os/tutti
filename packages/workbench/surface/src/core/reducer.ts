import type { WorkbenchAction } from "./actions.ts";
import {
  clampWorkbenchDragRect,
  clampWorkbenchRect,
  clampWorkbenchRectToVisibleArea,
  denormalizeWorkbenchFrameFromRect,
  getWorkbenchFullscreenRect,
  getWorkbenchLayoutPresetFrames,
  getWorkbenchQuickLayoutRect,
  getWorkbenchSafeLayoutRect,
  getWorkbenchSnapRect,
  normalizeWorkbenchFrameToRect,
  normalizeWorkbenchLayoutConstraints,
  rectsEqual,
  WORKBENCH_LAYOUT_PRESET_GAP_PX
} from "./geometry.ts";
import {
  focusWorkbenchStack,
  normalizeWorkbenchStack,
  removeFromWorkbenchStack
} from "./stack.ts";
import {
  defaultWorkbenchSurfaceSize,
  defaultWorkbenchLayoutConstraints,
  type WorkbenchLayoutPreset,
  type WorkbenchNode,
  type WorkbenchState
} from "./types.ts";

export function createWorkbenchInitialState<TData = unknown>(
  partial: Partial<WorkbenchState<TData>> = {}
): WorkbenchState<TData> {
  const nodes = partial.nodes ?? [];
  return {
    nodes,
    nodeStack: normalizeWorkbenchStack(nodes, partial.nodeStack ?? []),
    activeDragNodeId: partial.activeDragNodeId ?? null,
    activeResizeNodeId: partial.activeResizeNodeId ?? null,
    activeSnapTarget: partial.activeSnapTarget ?? null,
    surfaceSize: partial.surfaceSize ?? defaultWorkbenchSurfaceSize,
    layoutConstraints: normalizeWorkbenchLayoutConstraints(
      partial.layoutConstraints ?? defaultWorkbenchLayoutConstraints
    ),
    lockedLayout: partial.lockedLayout ?? null
  };
}

export function reduceWorkbenchState<TData>(
  state: WorkbenchState<TData>,
  action: WorkbenchAction<TData>
): WorkbenchState<TData> {
  switch (action.type) {
    case "replaceState": {
      const nextState = createWorkbenchInitialState({
        ...state,
        ...action.state
      });
      if (
        state.nodes === nextState.nodes &&
        state.nodeStack === nextState.nodeStack &&
        state.activeDragNodeId === nextState.activeDragNodeId &&
        state.activeResizeNodeId === nextState.activeResizeNodeId &&
        state.activeSnapTarget === nextState.activeSnapTarget &&
        state.surfaceSize === nextState.surfaceSize &&
        state.lockedLayout === nextState.lockedLayout &&
        layoutConstraintsEqual(
          state.layoutConstraints,
          nextState.layoutConstraints
        )
      ) {
        return state;
      }
      return nextState;
    }

    case "replaceNodes": {
      const nodeStack = normalizeWorkbenchStack(action.nodes, state.nodeStack);
      if (state.nodes === action.nodes && state.nodeStack === nodeStack) {
        return state;
      }
      return { ...state, nodes: action.nodes, nodeStack };
    }

    case "openNode": {
      const existing = state.nodes.some((node) => node.id === action.node.id);
      const nodes = existing
        ? state.nodes.map((node) =>
            node.id === action.node.id ? action.node : node
          )
        : [...state.nodes, action.node];
      const openedState: WorkbenchState<TData> = {
        ...state,
        nodes,
        nodeStack: focusWorkbenchStack(
          normalizeWorkbenchStack(nodes, state.nodeStack),
          action.node.id
        )
      };
      // A window opened while a layout is locked joins the locked grid: the
      // preset is re-applied with an extra slot. If the preset cannot fit
      // another slot the window stays floating and the lock is untouched.
      if (!existing && state.lockedLayout) {
        const grownState = applyLayoutPresetToNodes(
          openedState,
          [...state.lockedLayout.nodeIDs, action.node.id],
          state.lockedLayout.preset,
          { lock: true, reorderStack: false }
        );
        if (grownState !== openedState) {
          return grownState;
        }
      }
      return openedState;
    }

    case "closeNode":
      if (!state.nodes.some((node) => node.id === action.nodeID)) {
        return state;
      }
      return {
        ...state,
        nodes: state.nodes.filter((node) => node.id !== action.nodeID),
        nodeStack: removeFromWorkbenchStack(state.nodeStack, action.nodeID),
        lockedLayout: pruneLockedLayout(state.lockedLayout, action.nodeID)
      };

    case "focusNode":
      if (!state.nodes.some((node) => node.id === action.nodeID)) {
        return state;
      }
      return {
        ...state,
        nodes: state.nodes.map((node) =>
          node.id === action.nodeID
            ? { ...node, isMinimized: false, minimizedAtUnixMs: null }
            : node
        ),
        nodeStack: focusWorkbenchStack(state.nodeStack, action.nodeID)
      };

    case "minimizeNode":
      return updateNode(state, action.nodeID, (node) =>
        node.isMinimized
          ? node
          : {
              ...node,
              isMinimized: true,
              minimizedAtUnixMs: Date.now()
            }
      );

    case "restoreNode":
      return updateNode(state, action.nodeID, (node) =>
        node.isMinimized
          ? { ...node, isMinimized: false, minimizedAtUnixMs: null }
          : node
      );

    case "enterFullscreen":
      return updateNode(state, action.nodeID, (node) => {
        if (node.displayMode === "fullscreen") {
          return node;
        }
        return {
          ...node,
          displayMode: "fullscreen",
          restoreFrame: node.frame,
          isMinimized: false,
          minimizedAtUnixMs: null,
          frame: getWorkbenchFullscreenRect(
            state.surfaceSize,
            state.layoutConstraints,
            node.sizeConstraints
          )
        };
      });

    case "exitFullscreen":
      return updateNode(state, action.nodeID, (node) => {
        if (node.displayMode !== "fullscreen") {
          return node;
        }
        return {
          ...node,
          displayMode: "floating",
          frame: node.restoreFrame ?? node.frame,
          restoreFrame: null
        };
      });

    case "applyQuickLayout":
      return updateNode(state, action.nodeID, (node) => {
        const frame = getWorkbenchQuickLayoutRect(
          action.target,
          state.surfaceSize,
          state.layoutConstraints,
          node.sizeConstraints
        );
        if (
          node.displayMode === "floating" &&
          !node.isMinimized &&
          node.restoreFrame === null &&
          rectsEqual(node.frame, frame)
        ) {
          return node;
        }
        return {
          ...node,
          frame,
          displayMode: "floating" as const,
          restoreFrame: null,
          isMinimized: false,
          minimizedAtUnixMs: null
        };
      });

    case "applyLayoutPreset":
      return applyLayoutPresetToNodes(state, action.nodeIDs, action.preset, {
        lock: action.lock ?? false
      });

    case "applyVisibleLayoutPreset":
      return applyLayoutPresetToNodes(
        state,
        state.nodes.filter((node) => !node.isMinimized).map((node) => node.id),
        action.preset,
        { lock: false }
      );

    case "settleLockedDrag":
      return settleLockedDrag(state, action.nodeID);

    case "moveLockedNode":
      return moveLockedNode(state, action.nodeID, action.direction);

    case "releaseLockedLayout":
      if (state.lockedLayout === null) {
        return state;
      }
      return { ...state, lockedLayout: null };

    case "applyActiveSnapTarget":
    case "applySnapTarget":
      return updateNode(state, action.nodeID, (node) => {
        const frame = getWorkbenchSnapRect(
          action.type === "applySnapTarget"
            ? action.snapTarget
            : state.activeSnapTarget,
          state.surfaceSize,
          state.layoutConstraints,
          node.sizeConstraints
        );
        if (!frame) {
          return node;
        }
        if (
          node.displayMode === "floating" &&
          !node.isMinimized &&
          node.restoreFrame === null &&
          rectsEqual(node.frame, frame)
        ) {
          return node;
        }
        return {
          ...node,
          frame,
          displayMode: "floating",
          restoreFrame: null,
          isMinimized: false,
          minimizedAtUnixMs: null
        };
      });

    case "dragNode": {
      const draggedState = updateNode(state, action.nodeID, (node) => {
        const frame = clampWorkbenchDragRect(
          action.frame,
          state.surfaceSize,
          state.layoutConstraints,
          node.sizeConstraints
        );
        if (rectsEqual(node.frame, frame)) {
          return node;
        }
        return {
          ...node,
          frame,
          displayMode: "floating",
          restoreFrame:
            node.displayMode === "fullscreen" ? node.restoreFrame : null
        };
      });
      // Dragging a locked node is a slot-swap gesture (settled on pointer up
      // via "settleLockedDrag"), so it must not break the locked layout.
      if (isLockedLayoutNode(state, action.nodeID)) {
        return draggedState;
      }
      return releaseLockedLayout(state, draggedState);
    }

    case "moveNode":
    case "resizeNode": {
      // Resizing a locked node adjusts the shared grid dividers instead of
      // breaking the locked layout.
      if (
        action.type === "resizeNode" &&
        isLockedLayoutNode(state, action.nodeID)
      ) {
        return resizeLockedGrid(state, action.nodeID, action.frame);
      }
      return releaseLockedLayout(
        state,
        updateNode(state, action.nodeID, (node) => {
          const frame = clampWorkbenchRect(
            action.frame,
            state.surfaceSize,
            state.layoutConstraints,
            node.sizeConstraints
          );
          if (rectsEqual(node.frame, frame)) {
            return node;
          }
          return {
            ...node,
            frame,
            displayMode: "floating",
            restoreFrame:
              node.displayMode === "fullscreen" ? node.restoreFrame : null
          };
        })
      );
    }

    case "setActiveDragNode":
      if (state.activeDragNodeId === action.nodeID) {
        return state;
      }
      return { ...state, activeDragNodeId: action.nodeID };

    case "setActiveResizeNode":
      if (state.activeResizeNodeId === action.nodeID) {
        return state;
      }
      return { ...state, activeResizeNodeId: action.nodeID };

    case "setActiveSnapTarget":
      if (state.activeSnapTarget === action.snapTarget) {
        return state;
      }
      return { ...state, activeSnapTarget: action.snapTarget };

    case "setSurfaceSize": {
      if (
        state.surfaceSize.width === action.size.width &&
        state.surfaceSize.height === action.size.height
      ) {
        return state;
      }
      const resizedNodes = state.nodes.map((node) => {
        const frame =
          node.displayMode === "fullscreen"
            ? getWorkbenchFullscreenRect(
                action.size,
                state.layoutConstraints,
                node.sizeConstraints
              )
            : clampWorkbenchRectToVisibleArea(
                node.frame,
                action.size,
                state.layoutConstraints,
                undefined,
                node.sizeConstraints
              );
        return rectsEqual(node.frame, frame) ? node : { ...node, frame };
      });
      const resizedState: WorkbenchState<TData> = {
        ...state,
        surfaceSize: action.size,
        nodes: resizedNodes.every((node, index) => node === state.nodes[index])
          ? state.nodes
          : resizedNodes
      };
      // When a layout is locked, re-apply the layout at the new surface size so
      // the locked nodes keep scaling proportionally with the window. Preserve
      // the current stacking order (no focus reshuffle) on a passive resize.
      if (state.lockedLayout && state.lockedLayout.nodeIDs.length >= 2) {
        // A user-adjusted grid scales its custom slot geometry; otherwise the
        // preset frames are recomputed.
        if (state.lockedLayout.normalizedFrames) {
          return materializeLockedFrames(resizedState, state.lockedLayout);
        }
        return applyLayoutPresetToNodes(
          resizedState,
          state.lockedLayout.nodeIDs,
          state.lockedLayout.preset,
          { lock: true, reorderStack: false }
        );
      }
      return resizedState;
    }

    case "setLayoutConstraints": {
      const constraints = normalizeWorkbenchLayoutConstraints({
        ...state.layoutConstraints,
        ...action.constraints,
        safeArea: {
          ...state.layoutConstraints.safeArea,
          ...action.constraints.safeArea
        }
      });
      if (
        state.layoutConstraints.minWidth === constraints.minWidth &&
        state.layoutConstraints.minHeight === constraints.minHeight &&
        state.layoutConstraints.surfacePadding === constraints.surfacePadding &&
        state.layoutConstraints.safeArea.top === constraints.safeArea.top &&
        state.layoutConstraints.safeArea.right === constraints.safeArea.right &&
        state.layoutConstraints.safeArea.bottom ===
          constraints.safeArea.bottom &&
        state.layoutConstraints.safeArea.left === constraints.safeArea.left
      ) {
        return state;
      }
      return {
        ...state,
        layoutConstraints: constraints,
        nodes: state.nodes.map((node) =>
          node.displayMode === "fullscreen"
            ? {
                ...node,
                frame: getWorkbenchFullscreenRect(
                  state.surfaceSize,
                  constraints,
                  node.sizeConstraints
                )
              }
            : {
                ...node,
                frame: clampWorkbenchRectToVisibleArea(
                  node.frame,
                  state.surfaceSize,
                  constraints,
                  undefined,
                  node.sizeConstraints
                ),
                restoreFrame: node.restoreFrame
                  ? clampWorkbenchRectToVisibleArea(
                      node.restoreFrame,
                      state.surfaceSize,
                      constraints,
                      undefined,
                      node.sizeConstraints
                    )
                  : null
              }
        )
      };
    }

    case "setNodeSizeConstraints":
      return updateNode(state, action.nodeID, (node) => {
        if (
          sizeConstraintsEqual(node.sizeConstraints, action.sizeConstraints)
        ) {
          return node;
        }
        const frame =
          node.displayMode === "fullscreen"
            ? getWorkbenchFullscreenRect(
                state.surfaceSize,
                state.layoutConstraints,
                action.sizeConstraints
              )
            : clampWorkbenchRectToVisibleArea(
                node.frame,
                state.surfaceSize,
                state.layoutConstraints,
                undefined,
                action.sizeConstraints
              );
        const restoreFrame = node.restoreFrame
          ? clampWorkbenchRectToVisibleArea(
              node.restoreFrame,
              state.surfaceSize,
              state.layoutConstraints,
              undefined,
              action.sizeConstraints
            )
          : null;
        return {
          ...node,
          frame,
          restoreFrame,
          sizeConstraints: action.sizeConstraints
        };
      });
  }
}

function layoutConstraintsEqual(
  left: WorkbenchState["layoutConstraints"],
  right: WorkbenchState["layoutConstraints"]
): boolean {
  return (
    left.minWidth === right.minWidth &&
    left.minHeight === right.minHeight &&
    left.surfacePadding === right.surfacePadding &&
    left.safeArea.top === right.safeArea.top &&
    left.safeArea.right === right.safeArea.right &&
    left.safeArea.bottom === right.safeArea.bottom &&
    left.safeArea.left === right.safeArea.left
  );
}

function sizeConstraintsEqual(
  left: WorkbenchNode["sizeConstraints"],
  right: WorkbenchNode["sizeConstraints"]
): boolean {
  return (
    (left?.minWidth ?? null) === (right?.minWidth ?? null) &&
    (left?.minHeight ?? null) === (right?.minHeight ?? null)
  );
}

function updateNode<TData>(
  state: WorkbenchState<TData>,
  nodeID: string,
  update: (node: WorkbenchNode<TData>) => WorkbenchNode<TData>
): WorkbenchState<TData> {
  let changed = false;
  const nodes = state.nodes.map((node) => {
    if (node.id !== nodeID) {
      return node;
    }

    const nextNode = update(node);
    changed = changed || nextNode !== node;
    return nextNode;
  });

  if (!changed) {
    return state;
  }

  return {
    ...state,
    nodes,
    nodeStack: focusWorkbenchStack(state.nodeStack, nodeID)
  };
}

function applyLayoutPresetToNodes<TData>(
  state: WorkbenchState<TData>,
  inputNodeIDs: readonly string[],
  preset: WorkbenchLayoutPreset,
  options: { lock: boolean; reorderStack?: boolean }
): WorkbenchState<TData> {
  const nodeIDs = uniqueKnownNodeIDs(state.nodes, inputNodeIDs);
  if (nodeIDs.length === 0) {
    return state;
  }

  const frames = getWorkbenchLayoutPresetFrames(
    nodeIDs.length,
    preset,
    state.surfaceSize,
    state.layoutConstraints
  );
  if (!frames) {
    return state;
  }

  const frameByNodeID = new Map(
    nodeIDs.map((nodeID, index) => [nodeID, frames[index]] as const)
  );
  const nodes: WorkbenchNode<TData>[] = state.nodes.map((node) => {
    const frame = frameByNodeID.get(node.id);
    if (!frame) {
      return node;
    }
    const nextFrame = clampWorkbenchRect(
      frame,
      state.surfaceSize,
      state.layoutConstraints,
      node.sizeConstraints
    );
    return {
      ...node,
      frame: nextFrame,
      displayMode: "floating" as const,
      restoreFrame: null,
      isMinimized: false,
      minimizedAtUnixMs: null
    };
  });

  let nodeStack = state.nodeStack;
  if (options.reorderStack !== false) {
    for (const nodeID of nodeIDs) {
      nodeStack = focusWorkbenchStack(nodeStack, nodeID);
    }
  }

  const lockedLayout = options.lock ? { preset, nodeIDs } : null;

  return { ...state, nodes, nodeStack, lockedLayout };
}

function isLockedLayoutNode(state: WorkbenchState, nodeID: string): boolean {
  return state.lockedLayout?.nodeIDs.includes(nodeID) ?? false;
}

/**
 * Settles a completed drag of a locked-layout node: when the dragged node's
 * center rests over another locked node's slot the two nodes swap slots,
 * otherwise the dragged node snaps back. Either way the preset frames are
 * re-applied and the lock stays active.
 */
function settleLockedDrag<TData>(
  state: WorkbenchState<TData>,
  nodeID: string
): WorkbenchState<TData> {
  const lockedLayout = state.lockedLayout;
  if (!lockedLayout || !lockedLayout.nodeIDs.includes(nodeID)) {
    return state;
  }
  const draggedNode = state.nodes.find((node) => node.id === nodeID);
  if (!draggedNode) {
    return state;
  }

  const draggedCenter = {
    x: draggedNode.frame.x + draggedNode.frame.width / 2,
    y: draggedNode.frame.y + draggedNode.frame.height / 2
  };
  // The other locked nodes are still sitting in their slots during the drag,
  // so hit-testing their frames is hit-testing the slots.
  const targetNode = state.nodes.find(
    (node) =>
      node.id !== nodeID &&
      !node.isMinimized &&
      lockedLayout.nodeIDs.includes(node.id) &&
      frameContainsPoint(node.frame, draggedCenter)
  );
  return applyLockedArrangement(
    state,
    lockedLayout,
    targetNode ? { firstID: nodeID, secondID: targetNode.id } : null
  );
}

/**
 * Swaps a locked node with the nearest locked neighbor in the given direction
 * — the window-snapping shortcut behavior while a layout is locked. No-op when
 * there is no neighbor slot in that direction.
 */
function moveLockedNode<TData>(
  state: WorkbenchState<TData>,
  nodeID: string,
  direction: "left" | "right" | "up" | "down"
): WorkbenchState<TData> {
  const lockedLayout = state.lockedLayout;
  if (!lockedLayout || !lockedLayout.nodeIDs.includes(nodeID)) {
    return state;
  }
  const sourceNode = state.nodes.find((node) => node.id === nodeID);
  if (!sourceNode) {
    return state;
  }

  const sourceCenter = frameCenter(sourceNode.frame);
  let targetID: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const node of state.nodes) {
    if (
      node.id === nodeID ||
      node.isMinimized ||
      !lockedLayout.nodeIDs.includes(node.id)
    ) {
      continue;
    }
    const center = frameCenter(node.frame);
    const dx = center.x - sourceCenter.x;
    const dy = center.y - sourceCenter.y;
    const primary =
      direction === "left"
        ? -dx
        : direction === "right"
          ? dx
          : direction === "up"
            ? -dy
            : dy;
    if (primary <= 0.5) {
      continue;
    }
    const secondary =
      direction === "left" || direction === "right"
        ? Math.abs(dy)
        : Math.abs(dx);
    // Prefer slots aligned with the movement axis over closer diagonal ones.
    const score = primary + secondary * 2;
    if (score < bestScore) {
      bestScore = score;
      targetID = node.id;
    }
  }
  if (targetID === null) {
    return state;
  }

  return applyLockedArrangement(state, lockedLayout, {
    firstID: nodeID,
    secondID: targetID
  });
}

/**
 * Re-materializes the locked layout, optionally swapping two nodes' slots
 * first. A user-adjusted grid keeps its custom slot geometry (the slots trade
 * owners); a pristine grid re-derives its slots from the preset.
 */
function applyLockedArrangement<TData>(
  state: WorkbenchState<TData>,
  lockedLayout: NonNullable<WorkbenchState<TData>["lockedLayout"]>,
  swap: { firstID: string; secondID: string } | null
): WorkbenchState<TData> {
  const nodeIDs = swap
    ? swapNodeIDs(lockedLayout.nodeIDs, swap.firstID, swap.secondID)
    : lockedLayout.nodeIDs;
  if (lockedLayout.normalizedFrames) {
    let normalizedFrames = lockedLayout.normalizedFrames;
    if (swap) {
      const first = normalizedFrames[swap.firstID];
      const second = normalizedFrames[swap.secondID];
      if (first && second) {
        normalizedFrames = {
          ...normalizedFrames,
          [swap.firstID]: second,
          [swap.secondID]: first
        };
      }
    }
    return materializeLockedFrames(state, {
      ...lockedLayout,
      nodeIDs,
      normalizedFrames
    });
  }
  return applyLayoutPresetToNodes(state, nodeIDs, lockedLayout.preset, {
    lock: true,
    reorderStack: false
  });
}

/**
 * Sets every locked node's frame from the lock's normalized slot geometry,
 * scaled to the current safe layout rect.
 */
function materializeLockedFrames<TData>(
  state: WorkbenchState<TData>,
  lockedLayout: NonNullable<WorkbenchState<TData>["lockedLayout"]>
): WorkbenchState<TData> {
  const normalizedFrames = lockedLayout.normalizedFrames;
  if (!normalizedFrames) {
    return { ...state, lockedLayout };
  }
  const layoutRect = getWorkbenchSafeLayoutRect(
    state.surfaceSize,
    state.layoutConstraints
  );
  const lockedNodeIDs = new Set(lockedLayout.nodeIDs);
  const nodes = state.nodes.map((node) => {
    const normalized = normalizedFrames[node.id];
    if (!normalized || !lockedNodeIDs.has(node.id)) {
      return node;
    }
    const frame = clampWorkbenchRect(
      denormalizeWorkbenchFrameFromRect(normalized, layoutRect),
      state.surfaceSize,
      state.layoutConstraints,
      node.sizeConstraints
    );
    if (
      node.displayMode === "floating" &&
      !node.isMinimized &&
      node.restoreFrame === null &&
      rectsEqual(node.frame, frame)
    ) {
      return node;
    }
    return {
      ...node,
      frame,
      displayMode: "floating" as const,
      restoreFrame: null,
      isMinimized: false,
      minimizedAtUnixMs: null
    };
  });
  return { ...state, nodes, lockedLayout };
}

/**
 * Treats a resize of a locked node as moving the grid's shared dividers: every
 * locked edge sitting on the same divider line follows, clamped so all
 * affected windows keep their minimum sizes. Outer edges (on the layout rect
 * boundary) do not move. The resulting slot geometry is stored normalized so
 * future surface resizes scale it proportionally.
 */
function resizeLockedGrid<TData>(
  state: WorkbenchState<TData>,
  nodeID: string,
  requestedFrame: WorkbenchNode["frame"]
): WorkbenchState<TData> {
  const lockedLayout = state.lockedLayout;
  if (!lockedLayout) {
    return state;
  }
  const sourceNode = state.nodes.find((node) => node.id === nodeID);
  if (!sourceNode) {
    return state;
  }

  const layoutRect = getWorkbenchSafeLayoutRect(
    state.surfaceSize,
    state.layoutConstraints
  );
  const lockedNodeIDs = lockedLayout.nodeIDs.filter((lockedID) =>
    state.nodes.some((node) => node.id === lockedID)
  );
  const frameByNodeID = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >(
    state.nodes
      .filter((node) => lockedNodeIDs.includes(node.id))
      .map((node) => [
        node.id,
        {
          x: node.frame.x,
          y: node.frame.y,
          width: node.frame.width,
          height: node.frame.height
        }
      ])
  );
  const minSizeByNodeID = new Map(
    state.nodes
      .filter((node) => lockedNodeIDs.includes(node.id))
      .map(
        (node) =>
          [
            node.id,
            {
              minWidth: Math.max(
                state.layoutConstraints.minWidth,
                node.sizeConstraints?.minWidth ?? 0
              ),
              minHeight: Math.max(
                state.layoutConstraints.minHeight,
                node.sizeConstraints?.minHeight ?? 0
              )
            }
          ] as const
      )
  );

  const oldFrame = sourceNode.frame;
  let changed = false;
  const dividerMoves: Array<{
    axis: "x" | "y";
    from: number;
    to: number;
  }> = [
    { axis: "x" as const, from: oldFrame.x, to: requestedFrame.x },
    {
      axis: "x" as const,
      from: oldFrame.x + oldFrame.width,
      to: requestedFrame.x + requestedFrame.width
    },
    { axis: "y" as const, from: oldFrame.y, to: requestedFrame.y },
    {
      axis: "y" as const,
      from: oldFrame.y + oldFrame.height,
      to: requestedFrame.y + requestedFrame.height
    }
  ].filter((move) => Math.abs(move.to - move.from) > 0.1);

  const edgeTolerance = 2;
  // Slots are separated by the preset gap: a divider is the gap band between a
  // trailing edge at `from` and the leading edges at `from + gap`. Both sides
  // move together so the gap is preserved.
  const gapTolerance = WORKBENCH_LAYOUT_PRESET_GAP_PX + edgeTolerance;
  for (const move of dividerMoves) {
    const rectStart = move.axis === "x" ? layoutRect.x : layoutRect.y;
    const rectEnd =
      move.axis === "x"
        ? layoutRect.x + layoutRect.width
        : layoutRect.y + layoutRect.height;
    // Outer edges are not dividers; the grid always fills the layout rect.
    if (
      move.from - rectStart <= gapTolerance ||
      rectEnd - move.from <= gapTolerance
    ) {
      continue;
    }

    // Collect every locked edge inside the divider band (trailing edges end
    // at it, leading edges start just across the gap), then clamp the shift
    // so each window on either side keeps its minimum size and the grid stays
    // inside the layout rect.
    const trailing: string[] = [];
    const leading: string[] = [];
    let minDelta = Number.NEGATIVE_INFINITY;
    let maxDelta = Number.POSITIVE_INFINITY;
    for (const [lockedID, frame] of frameByNodeID) {
      const minSize = minSizeByNodeID.get(lockedID)!;
      const start = move.axis === "x" ? frame.x : frame.y;
      const size = move.axis === "x" ? frame.width : frame.height;
      const minLength =
        move.axis === "x" ? minSize.minWidth : minSize.minHeight;
      const endOffset = move.from - (start + size);
      const startOffset = start - move.from;
      if (endOffset >= -edgeTolerance && endOffset <= gapTolerance) {
        trailing.push(lockedID);
        // Grows/shrinks by delta at its end.
        minDelta = Math.max(minDelta, minLength - size);
        maxDelta = Math.min(maxDelta, rectEnd - (start + size));
      } else if (startOffset >= -edgeTolerance && startOffset <= gapTolerance) {
        leading.push(lockedID);
        // Shifts its start by delta, shrinking/growing accordingly.
        maxDelta = Math.min(maxDelta, size - minLength);
        minDelta = Math.max(minDelta, rectStart - start);
      }
    }
    if (trailing.length === 0 && leading.length === 0) {
      continue;
    }
    const delta = Math.min(Math.max(move.to - move.from, minDelta), maxDelta);
    if (Math.abs(delta) <= 0.1) {
      continue;
    }

    for (const lockedID of trailing) {
      const frame = frameByNodeID.get(lockedID)!;
      if (move.axis === "x") {
        frame.width += delta;
      } else {
        frame.height += delta;
      }
    }
    for (const lockedID of leading) {
      const frame = frameByNodeID.get(lockedID)!;
      if (move.axis === "x") {
        frame.x += delta;
        frame.width -= delta;
      } else {
        frame.y += delta;
        frame.height -= delta;
      }
    }
    changed = true;
  }

  if (!changed) {
    return state;
  }

  const normalizedFrames: Record<string, WorkbenchNode["frame"]> = {};
  for (const [lockedID, frame] of frameByNodeID) {
    normalizedFrames[lockedID] = normalizeWorkbenchFrameToRect(
      frame,
      layoutRect
    );
  }
  const nodes = state.nodes.map((node) => {
    const frame = frameByNodeID.get(node.id);
    if (!frame || rectsEqual(node.frame, frame)) {
      return node;
    }
    return { ...node, frame };
  });

  return {
    ...state,
    nodes,
    nodeStack: focusWorkbenchStack(state.nodeStack, nodeID),
    lockedLayout: { ...lockedLayout, normalizedFrames }
  };
}

function swapNodeIDs(
  nodeIDs: readonly string[],
  firstID: string,
  secondID: string
): string[] {
  return nodeIDs.map((entry) =>
    entry === firstID ? secondID : entry === secondID ? firstID : entry
  );
}

function frameCenter(frame: WorkbenchNode["frame"]): { x: number; y: number } {
  return {
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2
  };
}

function frameContainsPoint(
  frame: WorkbenchNode["frame"],
  point: { x: number; y: number }
): boolean {
  return (
    point.x >= frame.x &&
    point.x <= frame.x + frame.width &&
    point.y >= frame.y &&
    point.y <= frame.y + frame.height
  );
}

/**
 * Clears any locked layout once the user takes manual control of a node. Called
 * from drag/move/resize; returns the input state untouched when nothing changed
 * or no layout is locked, so store notifications stay minimal.
 */
function releaseLockedLayout<TData>(
  previousState: WorkbenchState<TData>,
  nextState: WorkbenchState<TData>
): WorkbenchState<TData> {
  if (nextState === previousState || nextState.lockedLayout === null) {
    return nextState;
  }
  return { ...nextState, lockedLayout: null };
}

function pruneLockedLayout(
  lockedLayout: WorkbenchState["lockedLayout"],
  removedNodeID: string
): WorkbenchState["lockedLayout"] {
  if (!lockedLayout || !lockedLayout.nodeIDs.includes(removedNodeID)) {
    return lockedLayout;
  }
  const nodeIDs = lockedLayout.nodeIDs.filter(
    (nodeID) => nodeID !== removedNodeID
  );
  // A preset needs at least two nodes to arrange; drop the lock otherwise.
  // Custom slot geometry is dropped with it: the preset re-derives slots for
  // the remaining nodes (the grid heals instead of keeping a hole).
  return nodeIDs.length >= 2 ? { preset: lockedLayout.preset, nodeIDs } : null;
}

function uniqueKnownNodeIDs<TData>(
  nodes: readonly WorkbenchNode<TData>[],
  nodeIDs: readonly string[]
): string[] {
  const knownNodeIDs = new Set(nodes.map((node) => node.id));
  const orderedNodeIDs: string[] = [];

  for (const nodeID of nodeIDs) {
    if (!knownNodeIDs.has(nodeID) || orderedNodeIDs.includes(nodeID)) {
      continue;
    }
    orderedNodeIDs.push(nodeID);
  }

  return orderedNodeIDs;
}
