import { memo, useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  selectFocusedWorkbenchNode,
  selectWorkbenchNodeZIndex,
  selectWorkbenchSnapPreviewRect
} from "../core/selectors.ts";
import type { WorkbenchNode } from "../core/types.ts";
import type {
  WorkbenchKeepMinimizedNodeMounted,
  WorkbenchRenderNode,
  WorkbenchSurfacePresentation,
  WorkbenchRenderWindowActions,
  WorkbenchRenderWindowHeader,
  WorkbenchResolveFullscreenHeaderMode,
  WorkbenchResolveWindowSurfaceLayer,
  WorkbenchResolveWindowZIndex,
  WorkbenchResolveWindowChromeMode,
  WorkbenchResolveWindowHeaderPresentation,
  WorkbenchWindowChromeMode
} from "./types.ts";
import type { WorkbenchGenieController } from "./useWorkbenchGenieAnimation.tsx";
import type { WorkbenchGenieNodeVisibility } from "./genieNodeVisibility.ts";
import type { WorkbenchNodePresentationTransitionStore } from "./nodePresentationTransitions.ts";
import { useWorkbenchController } from "./WorkbenchProvider.tsx";
import {
  WorkbenchVisualOcclusionPresentationProvider,
  WorkbenchWindowFrame
} from "./WorkbenchWindowFrame.tsx";
import { useWorkbenchSelector } from "./hooks/useWorkbenchSelector.ts";
import { createWorkbenchNodeLayerNodeIDsSelector } from "./renderedNodeIds.ts";
import type { WorkbenchWindowChromeI18nRuntime } from "./workbenchWindowI18n.ts";
import { resolveWorkbenchWindowChromeMode } from "./windowHeader.ts";

export interface WorkbenchNodeLayerProps<TData = unknown> {
  genie: WorkbenchGenieController<TData>;
  edgeSnapEnabled?: boolean;
  interactive?: boolean;
  nodePresentationTransitions: WorkbenchNodePresentationTransitionStore;
  presentation?: WorkbenchSurfacePresentation | null;
  renderNode: WorkbenchRenderNode<TData>;
  shouldKeepMinimizedNodeMounted?: WorkbenchKeepMinimizedNodeMounted<TData>;
  renderWindowActions?: WorkbenchRenderWindowActions<TData>;
  renderWindowHeader?: WorkbenchRenderWindowHeader<TData>;
  resolveFullscreenHeaderMode?: WorkbenchResolveFullscreenHeaderMode<TData>;
  resolveWindowHeaderPresentation?: WorkbenchResolveWindowHeaderPresentation<TData>;
  resolveWindowSurfaceLayer?: WorkbenchResolveWindowSurfaceLayer<TData>;
  resolveWindowZIndex?: WorkbenchResolveWindowZIndex<TData>;
  windowChromeMode?:
    | WorkbenchWindowChromeMode
    | WorkbenchResolveWindowChromeMode<TData>;
  windowChromeI18n?: WorkbenchWindowChromeI18nRuntime;
}

export function WorkbenchNodeLayer<TData>({
  genie,
  edgeSnapEnabled = false,
  interactive = true,
  nodePresentationTransitions,
  presentation,
  renderNode,
  shouldKeepMinimizedNodeMounted,
  renderWindowActions,
  renderWindowHeader,
  resolveFullscreenHeaderMode,
  resolveWindowHeaderPresentation,
  resolveWindowSurfaceLayer,
  resolveWindowZIndex,
  windowChromeMode,
  windowChromeI18n
}: WorkbenchNodeLayerProps<TData>) {
  const selectNodeLayerNodeIDs = useMemo(
    () =>
      createWorkbenchNodeLayerNodeIDsSelector({
        missionControl: presentation?.mode === "mission-control",
        resolveWindowSurfaceLayer,
        shouldKeepMinimizedNodeMounted
      }),
    [
      presentation?.mode,
      resolveWindowSurfaceLayer,
      shouldKeepMinimizedNodeMounted
    ]
  );
  const { defaultNodeIDs, dialogPopoverNodeIDs } = useWorkbenchSelector(
    selectNodeLayerNodeIDs
  );
  const genieHiddenNodeIDs = useSyncExternalStore(
    genie.nodeVisibility.subscribeAll,
    genie.nodeVisibility.getHiddenNodeIDsSnapshot,
    genie.nodeVisibility.getHiddenNodeIDsSnapshot
  );
  const pendingMinimizedNodeID = genie.pendingMinimizedNode?.id ?? null;
  const visuallyHiddenNodeIDs = useMemo(() => {
    if (
      pendingMinimizedNodeID === null ||
      genieHiddenNodeIDs.has(pendingMinimizedNodeID)
    ) {
      return genieHiddenNodeIDs;
    }
    return new Set([...genieHiddenNodeIDs, pendingMinimizedNodeID]);
  }, [genieHiddenNodeIDs, pendingMinimizedNodeID]);
  const presentationTransitionNodeIDs = useSyncExternalStore(
    nodePresentationTransitions.subscribe,
    nodePresentationTransitions.getSnapshot,
    nodePresentationTransitions.getSnapshot
  );
  const nonOccludingNodeIDs = useMemo(() => {
    if (presentationTransitionNodeIDs.size === 0) {
      return visuallyHiddenNodeIDs;
    }
    return new Set([
      ...visuallyHiddenNodeIDs,
      ...presentationTransitionNodeIDs
    ]);
  }, [presentationTransitionNodeIDs, visuallyHiddenNodeIDs]);
  const visualOcclusionPresentation = useMemo(
    () => ({
      hiddenNodeIDs: visuallyHiddenNodeIDs,
      nonOccludingNodeIDs,
      topLayerNodeIDs: dialogPopoverNodeIDs
    }),
    [dialogPopoverNodeIDs, nonOccludingNodeIDs, visuallyHiddenNodeIDs]
  );
  const snapPreviewRect = useWorkbenchSelector(selectWorkbenchSnapPreviewRect);
  const presentationInteraction =
    interactive && presentation?.mode === "mission-control"
      ? (presentation.interaction ?? null)
      : null;
  const dialogPopoverLayer =
    dialogPopoverNodeIDs.length > 0 ? (
      <MemoizedWorkbenchNodeLayerGroup
        className="workbench-node-layer workbench-node-layer--dialog-popover"
        edgeSnapEnabled={edgeSnapEnabled}
        fullscreenHeaderMode={resolveFullscreenHeaderMode}
        genieNodeVisibility={genie.nodeVisibility}
        interactive={interactive}
        minimizeNodeToAnchor={genie.minimizeNodeToAnchor}
        nodePresentationTransitions={nodePresentationTransitions}
        nodeIDs={dialogPopoverNodeIDs}
        presentation={presentation}
        renderNode={renderNode}
        renderWindowActions={renderWindowActions}
        renderWindowHeader={renderWindowHeader}
        resolveWindowHeaderPresentation={resolveWindowHeaderPresentation}
        resolveWindowZIndex={resolveWindowZIndex}
        windowChromeI18n={windowChromeI18n}
        windowChromeMode={windowChromeMode}
      />
    ) : null;

  return (
    <WorkbenchVisualOcclusionPresentationProvider
      presentation={visualOcclusionPresentation}
    >
      <MemoizedWorkbenchNodeLayerGroup
        className="workbench-node-layer"
        edgeSnapEnabled={edgeSnapEnabled}
        fullscreenHeaderMode={resolveFullscreenHeaderMode}
        genieNodeVisibility={genie.nodeVisibility}
        interactive={interactive}
        minimizeNodeToAnchor={genie.minimizeNodeToAnchor}
        nodePresentationTransitions={nodePresentationTransitions}
        nodeIDs={defaultNodeIDs}
        onBackdropPress={presentationInteraction?.onBackdropPress}
        presentation={presentation}
        renderNode={renderNode}
        renderWindowActions={renderWindowActions}
        renderWindowHeader={renderWindowHeader}
        resolveWindowHeaderPresentation={resolveWindowHeaderPresentation}
        resolveWindowZIndex={resolveWindowZIndex}
        snapPreviewRect={snapPreviewRect}
        windowChromeI18n={windowChromeI18n}
        windowChromeMode={windowChromeMode}
      />
      {typeof document === "undefined"
        ? dialogPopoverLayer
        : dialogPopoverLayer
          ? createPortal(dialogPopoverLayer, document.body)
          : null}
    </WorkbenchVisualOcclusionPresentationProvider>
  );
}

interface WorkbenchNodeLayerGroupProps<TData = unknown> {
  className: string;
  edgeSnapEnabled: boolean;
  fullscreenHeaderMode?: WorkbenchResolveFullscreenHeaderMode<TData>;
  genieNodeVisibility: WorkbenchGenieNodeVisibility;
  interactive: boolean;
  minimizeNodeToAnchor: WorkbenchGenieController<TData>["minimizeNodeToAnchor"];
  nodePresentationTransitions: WorkbenchNodePresentationTransitionStore;
  nodeIDs: readonly string[];
  onBackdropPress?: () => void;
  presentation?: WorkbenchSurfacePresentation | null;
  renderNode: WorkbenchRenderNode<TData>;
  renderWindowActions?: WorkbenchRenderWindowActions<TData>;
  renderWindowHeader?: WorkbenchRenderWindowHeader<TData>;
  resolveWindowHeaderPresentation?: WorkbenchResolveWindowHeaderPresentation<TData>;
  resolveWindowZIndex?: WorkbenchResolveWindowZIndex<TData>;
  snapPreviewRect?: ReturnType<typeof selectWorkbenchSnapPreviewRect>;
  windowChromeMode?:
    | WorkbenchWindowChromeMode
    | WorkbenchResolveWindowChromeMode<TData>;
  windowChromeI18n?: WorkbenchWindowChromeI18nRuntime;
}

function WorkbenchNodeLayerGroup<TData>({
  className,
  edgeSnapEnabled,
  fullscreenHeaderMode,
  genieNodeVisibility,
  interactive,
  minimizeNodeToAnchor,
  nodePresentationTransitions,
  nodeIDs,
  onBackdropPress,
  presentation,
  renderNode,
  renderWindowActions,
  renderWindowHeader,
  resolveWindowHeaderPresentation,
  resolveWindowZIndex,
  snapPreviewRect,
  windowChromeI18n,
  windowChromeMode
}: WorkbenchNodeLayerGroupProps<TData>) {
  return (
    <div
      className={className}
      data-workbench-interactive={interactive ? "true" : "false"}
      onClick={
        onBackdropPress
          ? (event) => {
              if (event.target !== event.currentTarget) {
                return;
              }
              onBackdropPress();
            }
          : undefined
      }
    >
      {snapPreviewRect ? (
        <div
          className="workbench-snap-preview"
          style={{
            height: snapPreviewRect.height,
            left: snapPreviewRect.x,
            top: snapPreviewRect.y,
            width: snapPreviewRect.width
          }}
        />
      ) : null}
      {nodeIDs.map((nodeID) => (
        <MemoizedWorkbenchNodeLayerItem
          key={nodeID}
          fullscreenHeaderMode={fullscreenHeaderMode}
          genieNodeVisibility={genieNodeVisibility}
          edgeSnapEnabled={edgeSnapEnabled}
          interactive={interactive}
          minimizeNodeToAnchor={minimizeNodeToAnchor}
          nodePresentationTransitions={nodePresentationTransitions}
          nodeID={nodeID}
          presentation={presentation}
          renderNode={renderNode}
          renderWindowActions={renderWindowActions}
          renderWindowHeader={renderWindowHeader}
          resolveWindowHeaderPresentation={resolveWindowHeaderPresentation}
          resolveWindowZIndex={resolveWindowZIndex}
          windowChromeI18n={windowChromeI18n}
          windowChromeMode={windowChromeMode}
        />
      ))}
    </div>
  );
}

const MemoizedWorkbenchNodeLayerGroup = memo(
  WorkbenchNodeLayerGroup
) as typeof WorkbenchNodeLayerGroup;

interface WorkbenchNodeLayerItemProps<TData = unknown> {
  fullscreenHeaderMode?: WorkbenchResolveFullscreenHeaderMode<TData>;
  genieNodeVisibility: WorkbenchGenieNodeVisibility;
  edgeSnapEnabled: boolean;
  interactive: boolean;
  minimizeNodeToAnchor: WorkbenchGenieController<TData>["minimizeNodeToAnchor"];
  nodePresentationTransitions: WorkbenchNodePresentationTransitionStore;
  nodeID: string;
  presentation?: WorkbenchSurfacePresentation | null;
  renderNode: WorkbenchRenderNode<TData>;
  renderWindowActions?: WorkbenchRenderWindowActions<TData>;
  renderWindowHeader?: WorkbenchRenderWindowHeader<TData>;
  resolveWindowHeaderPresentation?: WorkbenchResolveWindowHeaderPresentation<TData>;
  resolveWindowZIndex?: WorkbenchResolveWindowZIndex<TData>;
  windowChromeMode?:
    | WorkbenchWindowChromeMode
    | WorkbenchResolveWindowChromeMode<TData>;
  windowChromeI18n?: WorkbenchWindowChromeI18nRuntime;
}

function WorkbenchNodeLayerItem<TData>({
  fullscreenHeaderMode,
  genieNodeVisibility,
  edgeSnapEnabled,
  interactive,
  minimizeNodeToAnchor,
  nodePresentationTransitions,
  nodeID,
  presentation,
  renderNode,
  renderWindowActions,
  renderWindowHeader,
  resolveWindowHeaderPresentation,
  resolveWindowZIndex,
  windowChromeI18n,
  windowChromeMode
}: WorkbenchNodeLayerItemProps<TData>) {
  const controller = useWorkbenchController<TData>();
  const node = useWorkbenchSelector<TData, WorkbenchNode<TData> | null>(
    (state) => state.nodes.find((candidate) => candidate.id === nodeID) ?? null
  );
  const isFocused = useWorkbenchSelector(
    (state) => selectFocusedWorkbenchNode(state)?.id === nodeID
  );
  const isDragging = useWorkbenchSelector(
    (state) => state.activeDragNodeId === nodeID
  );
  const isResizing = useWorkbenchSelector(
    (state) => state.activeResizeNodeId === nodeID
  );
  const zIndex = useWorkbenchSelector((state) =>
    selectWorkbenchNodeZIndex(state, nodeID)
  );

  if (!node) {
    return null;
  }

  return (
    <WorkbenchWindowFrame
      edgeSnapEnabled={edgeSnapEnabled}
      hiddenMounted={node.isMinimized}
      interactive={interactive}
      presentation={presentation}
      node={node}
      genieNodeVisibility={genieNodeVisibility}
      minimizeNodeToAnchor={minimizeNodeToAnchor}
      nodePresentationTransitions={nodePresentationTransitions}
      resolveWindowZIndex={resolveWindowZIndex}
      fullscreenHeaderMode={fullscreenHeaderMode?.({
        controller,
        node
      })}
      renderActions={renderWindowActions}
      renderHeader={renderWindowHeader}
      windowHeaderPresentation={resolveWindowHeaderPresentation?.({
        controller,
        node
      })}
      windowChromeI18n={windowChromeI18n}
      windowChromeMode={resolveWorkbenchWindowChromeMode({
        controller,
        node,
        windowChromeMode
      })}
    >
      {renderNode({
        node,
        isDragging,
        isResizing,
        layout: {
          frame: node.frame,
          presentation,
          zIndex,
          isFocused
        },
        controller
      })}
    </WorkbenchWindowFrame>
  );
}

const MemoizedWorkbenchNodeLayerItem = memo(
  WorkbenchNodeLayerItem
) as typeof WorkbenchNodeLayerItem;
