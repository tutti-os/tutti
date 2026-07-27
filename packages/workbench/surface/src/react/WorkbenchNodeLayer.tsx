import { Fragment, memo, useMemo } from "react";
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
import { useWorkbenchController } from "./WorkbenchProvider.tsx";
import { WorkbenchWindowFrame } from "./WorkbenchWindowFrame.tsx";
import { useWorkbenchSelector } from "./hooks/useWorkbenchSelector.ts";
import { createRenderedWorkbenchNodeIDsSelector } from "./renderedNodeIds.ts";
import type { WorkbenchWindowChromeI18nRuntime } from "./workbenchWindowI18n.ts";
import { resolveWorkbenchWindowChromeMode } from "./windowHeader.ts";

export interface WorkbenchNodeLayerProps<TData = unknown> {
  genie: WorkbenchGenieController<TData>;
  edgeSnapEnabled?: boolean;
  interactive?: boolean;
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
  const selectRenderedNodeIDs = useMemo(
    () =>
      createRenderedWorkbenchNodeIDsSelector(shouldKeepMinimizedNodeMounted),
    [shouldKeepMinimizedNodeMounted]
  );
  const nodeIDs = useWorkbenchSelector<TData, readonly string[]>(
    selectRenderedNodeIDs
  );
  const { defaultNodeIDs, dialogPopoverNodeIDs } = useWorkbenchSelector<
    TData,
    {
      defaultNodeIDs: readonly string[];
      dialogPopoverNodeIDs: readonly string[];
    }
  >((state) => {
    if (
      !resolveWindowSurfaceLayer ||
      presentation?.mode === "mission-control"
    ) {
      return {
        defaultNodeIDs: nodeIDs,
        dialogPopoverNodeIDs: [] as string[]
      };
    }

    const nodeByID = new Map(state.nodes.map((node) => [node.id, node]));
    const nextDefaultNodeIDs: string[] = [];
    const nextDialogPopoverNodeIDs: string[] = [];

    for (const nodeID of nodeIDs) {
      const node = nodeByID.get(nodeID);
      if (node && resolveWindowSurfaceLayer({ node }) === "dialog-popover") {
        nextDialogPopoverNodeIDs.push(nodeID);
      } else {
        nextDefaultNodeIDs.push(nodeID);
      }
    }

    return {
      defaultNodeIDs: nextDefaultNodeIDs,
      dialogPopoverNodeIDs: nextDialogPopoverNodeIDs
    };
  });
  const snapPreviewRect = useWorkbenchSelector(selectWorkbenchSnapPreviewRect);
  const presentationInteraction =
    interactive && presentation?.mode === "mission-control"
      ? (presentation.interaction ?? null)
      : null;
  const dialogPopoverLayer =
    dialogPopoverNodeIDs.length > 0 ? (
      <WorkbenchNodeLayerGroup
        className="workbench-node-layer workbench-node-layer--dialog-popover"
        edgeSnapEnabled={edgeSnapEnabled}
        fullscreenHeaderMode={resolveFullscreenHeaderMode}
        genie={genie}
        interactive={interactive}
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
    <Fragment>
      <WorkbenchNodeLayerGroup
        className="workbench-node-layer"
        edgeSnapEnabled={edgeSnapEnabled}
        fullscreenHeaderMode={resolveFullscreenHeaderMode}
        genie={genie}
        interactive={interactive}
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
    </Fragment>
  );
}

interface WorkbenchNodeLayerGroupProps<TData = unknown> {
  className: string;
  edgeSnapEnabled: boolean;
  fullscreenHeaderMode?: WorkbenchResolveFullscreenHeaderMode<TData>;
  genie: WorkbenchGenieController<TData>;
  interactive: boolean;
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
  genie,
  interactive,
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
          genie={genie}
          edgeSnapEnabled={edgeSnapEnabled}
          interactive={interactive}
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

interface WorkbenchNodeLayerItemProps<TData = unknown> {
  fullscreenHeaderMode?: WorkbenchResolveFullscreenHeaderMode<TData>;
  genie: WorkbenchGenieController<TData>;
  edgeSnapEnabled: boolean;
  interactive: boolean;
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
  genie,
  edgeSnapEnabled,
  interactive,
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
      genie={genie}
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
