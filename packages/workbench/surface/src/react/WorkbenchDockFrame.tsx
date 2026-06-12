import { useMemo, type ReactNode } from "react";
import {
  selectFocusedWorkbenchNode,
  selectFullscreenNodeToExitBeforeDockLaunch
} from "../core/selectors.ts";
import type { WorkbenchNode } from "../core/types.ts";
import type { WorkbenchDockContext, WorkbenchDockPlacement } from "./types.ts";
import { useWorkbenchController } from "./WorkbenchProvider.tsx";
import { createWorkbenchDockNodesSelector } from "./dockNodeSelectors.ts";
import { useWorkbenchSelector } from "./hooks/useWorkbenchSelector.ts";
import type { WorkbenchGenieController } from "./useWorkbenchGenieAnimation.tsx";

export interface WorkbenchDockFrameProps<TData = unknown> {
  dockPlacement?: WorkbenchDockPlacement;
  genie: WorkbenchGenieController;
  interactive?: boolean;
  renderDock?: (context: WorkbenchDockContext<TData>) => ReactNode;
}

export function WorkbenchDockFrame<TData>({
  dockPlacement = "bottom",
  genie,
  interactive = true,
  renderDock
}: WorkbenchDockFrameProps<TData>) {
  const controller = useWorkbenchController<TData>();
  const selectDockNodes = useMemo(
    () => createWorkbenchDockNodesSelector<TData>(),
    []
  );
  const hasFullscreenNode = useWorkbenchSelector((state) =>
    state.nodes.some(
      (node) => node.displayMode === "fullscreen" && !node.isMinimized
    )
  );
  const nodes = useWorkbenchSelector<TData, readonly WorkbenchNode<TData>[]>(
    selectDockNodes
  );
  const minimizedNodes = useMemo(
    () => nodes.filter((node) => node.isMinimized),
    [nodes]
  );
  const focusedNodeId = useWorkbenchSelector(
    (state) => selectFocusedWorkbenchNode(state)?.id ?? null
  );

  if (!renderDock && minimizedNodes.length === 0) {
    return null;
  }

  return (
    <>
      {hasFullscreenNode ? (
        <div
          className="workbench-dock-frame__immersive-hover-zone"
          data-dock-placement={dockPlacement}
          aria-hidden
        />
      ) : null}
      <div
        className="workbench-dock-frame"
        data-dock-placement={dockPlacement}
        data-immersive-state={hasFullscreenNode ? "hidden" : "disabled"}
      >
        {renderDock
          ? renderDock({
              controller,
              focusedNodeId,
              genie: {
                launchNodeFromAnchor: (anchorKey, nodeID, launch) => {
                  const fullscreenNode = interactive
                    ? selectFullscreenNodeToExitBeforeDockLaunch(
                        controller.getSnapshot(),
                        nodeID
                      )
                    : null;
                  if (fullscreenNode) {
                    controller.commands.exitFullscreen(fullscreenNode.id);
                  }
                  genie.launchNodeFromAnchor(anchorKey, nodeID, launch);
                },
                registerDockAnchor: (anchorKey, element) => {
                  genie.registerDockAnchor(anchorKey, element);
                },
                shouldAnimateMinimizedDockEnter: (nodeID) => {
                  return genie.shouldAnimateMinimizedDockEnter(nodeID);
                }
              },
              minimizedNodes,
              nodes
            })
          : null}
      </div>
    </>
  );
}
