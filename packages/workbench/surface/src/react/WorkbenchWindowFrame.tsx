import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef
} from "react";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { Checkbox } from "@tutti-os/ui-system";
import {
  selectFocusedWorkbenchNode,
  selectWorkbenchNodeZIndex
} from "../core/selectors.ts";
import type { WorkbenchNode, WorkbenchResizeHandle } from "../core/types.ts";
import { useWorkbenchController } from "./WorkbenchProvider.tsx";
import { WorkbenchWindowFullscreenToggle } from "./WorkbenchWindowFullscreenToggle.tsx";
import { useWorkbenchDrag } from "./hooks/useWorkbenchDrag.ts";
import { useWorkbenchResize } from "./hooks/useWorkbenchResize.ts";
import { useWorkbenchSelector } from "./hooks/useWorkbenchSelector.ts";
import {
  createWorkbenchWindowChromeI18nRuntime,
  workbenchWindowChromeI18nResources,
  type WorkbenchWindowChromeI18nRuntime
} from "./workbenchWindowI18n.ts";
import type {
  WorkbenchFullscreenHeaderMode,
  WorkbenchRenderWindowActions,
  WorkbenchRenderWindowHeader,
  WorkbenchResolveWindowZIndex,
  WorkbenchSurfacePresentation,
  WorkbenchWindowChromeMode
} from "./types.ts";
import type { WorkbenchGenieController } from "./useWorkbenchGenieAnimation.tsx";
import { resolveWorkbenchWindowHeader } from "./windowHeader.ts";

export interface WorkbenchWindowFrameProps<TData = unknown> {
  children: ReactNode;
  genie: WorkbenchGenieController;
  edgeSnapEnabled?: boolean;
  hiddenMounted?: boolean;
  interactive?: boolean;
  node: WorkbenchNode<TData>;
  presentation?: WorkbenchSurfacePresentation | null;
  renderActions?: WorkbenchRenderWindowActions<TData>;
  renderHeader?: WorkbenchRenderWindowHeader<TData>;
  resolveWindowZIndex?: WorkbenchResolveWindowZIndex<TData>;
  fullscreenHeaderMode?: WorkbenchFullscreenHeaderMode;
  windowChromeMode?: WorkbenchWindowChromeMode;
  windowChromeI18n?: WorkbenchWindowChromeI18nRuntime;
}

const resizeHandles: WorkbenchResizeHandle[] = [
  "north",
  "east",
  "south",
  "west",
  "north-east",
  "north-west",
  "south-east",
  "south-west"
];

const defaultWindowChromeI18n = createWorkbenchWindowChromeI18nRuntime(
  createI18nRuntime({
    dictionaries: [workbenchWindowChromeI18nResources.en]
  })
);

function resolveWorkbenchNodeLaunchSource(data: unknown): string | undefined {
  if (
    data &&
    typeof data === "object" &&
    "launchSource" in data &&
    typeof data.launchSource === "string" &&
    data.launchSource.length > 0
  ) {
    return data.launchSource;
  }
  return undefined;
}

function resolveWorkbenchNodeTypeId(data: unknown): string | undefined {
  if (
    data &&
    typeof data === "object" &&
    "typeId" in data &&
    typeof data.typeId === "string"
  ) {
    return data.typeId;
  }

  return undefined;
}

export function WorkbenchWindowFrame<TData>({
  children,
  edgeSnapEnabled = false,
  genie,
  hiddenMounted = false,
  interactive = true,
  node,
  presentation = null,
  renderActions,
  renderHeader,
  resolveWindowZIndex,
  windowChromeMode = "system",
  windowChromeI18n
}: WorkbenchWindowFrameProps<TData>) {
  const controller = useWorkbenchController<TData>();
  const baseZIndex = useWorkbenchSelector((state) =>
    selectWorkbenchNodeZIndex(state, node.id)
  );
  const zIndex =
    resolveWindowZIndex?.({
      baseZIndex,
      node
    }) ?? baseZIndex;
  const isFocused = useWorkbenchSelector(
    (state) => selectFocusedWorkbenchNode(state)?.id === node.id
  );
  const isDragging = useWorkbenchSelector(
    (state) => state.activeDragNodeId === node.id
  );
  const isResizing = useWorkbenchSelector(
    (state) => state.activeResizeNodeId === node.id
  );
  const onDragStart = useWorkbenchDrag(node, { edgeSnapEnabled });
  const onHeaderDoubleClick = () => {
    if (!interactive) {
      return;
    }
    controller.commands.focusNode(node.id);
    controller.commands.applySnapTarget(node.id, "top");
  };
  const minimizeNodeToAnchorRef = useRef(genie.minimizeNodeToAnchor);
  useLayoutEffect(() => {
    minimizeNodeToAnchorRef.current = genie.minimizeNodeToAnchor;
  }, [genie.minimizeNodeToAnchor]);
  const minimizeNodeToAnchor = useCallback(
    (nodeID: string, minimize?: () => void) => {
      minimizeNodeToAnchorRef.current(nodeID, minimize);
    },
    []
  );
  const genieControls = useMemo(
    () => ({ minimizeNodeToAnchor }),
    [minimizeNodeToAnchor]
  );
  const headerRenderRevision = useMemo(
    () => ({}),
    [
      controller,
      edgeSnapEnabled,
      interactive,
      renderActions,
      renderHeader,
      windowChromeI18n
    ]
  );
  const defaultActions = interactive ? (
    <div
      className="workbench-window__traffic-light-actions"
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      {renderActions
        ? renderActions({
            controller,
            genie: genieControls,
            node
          })
        : null}
      <WorkbenchWindowFullscreenToggle
        controller={controller}
        i18n={windowChromeI18n ?? defaultWindowChromeI18n}
        node={node}
      />
    </div>
  ) : null;
  const resolvedHeader = resolveWorkbenchWindowHeader({
    controller,
    defaultActions,
    genie: genieControls,
    isDragging,
    isFocused,
    isResizing,
    node,
    onDoubleClick: onHeaderDoubleClick,
    onDragStart,
    renderHeader: interactive ? renderHeader : undefined,
    renderRevision: headerRenderRevision,
    windowChromeMode
  });
  const shouldRenderCustomHeader =
    resolvedHeader.windowChromeMode === "custom-header";
  const resolvedFullscreenHeaderMode: WorkbenchFullscreenHeaderMode =
    "persistent";
  const presentationMode = presentation?.mode ?? null;
  const presentationFrame = presentation?.frameByNodeId.get(node.id) ?? null;
  const isPresentationHidden =
    presentationMode === "mission-control" &&
    !presentation?.visibleNodeIds.has(node.id);
  const presentationInteraction =
    interactive &&
    presentationMode === "mission-control" &&
    !isPresentationHidden
      ? (presentation?.interaction ?? null)
      : null;
  const isMissionControlSelected =
    presentationInteraction?.selectedNodeIds.has(node.id) ?? false;
  const presentationScale =
    presentationMode === "mission-control" && presentationFrame
      ? Math.min(
          presentationFrame.width / Math.max(1, node.frame.width),
          presentationFrame.height / Math.max(1, node.frame.height)
        )
      : 1;
  const presentationOffsetX =
    presentationMode === "mission-control" && presentationFrame
      ? presentationFrame.x +
        Math.max(
          0,
          (presentationFrame.width - node.frame.width * presentationScale) / 2
        ) -
        node.frame.x
      : 0;
  const presentationOffsetY =
    presentationMode === "mission-control" && presentationFrame
      ? presentationFrame.y +
        Math.max(
          0,
          (presentationFrame.height - node.frame.height * presentationScale) / 2
        ) -
        node.frame.y
      : 0;
  const shellTransform =
    presentationMode === "mission-control" && presentationFrame
      ? `matrix(${presentationScale}, 0, 0, ${presentationScale}, ${presentationOffsetX}, ${presentationOffsetY})`
      : undefined;

  return (
    <section
      aria-hidden={hiddenMounted || isPresentationHidden ? true : undefined}
      className="workbench-window-shell"
      data-focused={isFocused ? "true" : "false"}
      data-display-mode={node.displayMode}
      data-genie-state={genie.isNodeGenieHidden(node.id) ? "hidden" : "visible"}
      data-launch-source={resolveWorkbenchNodeLaunchSource(node.data)}
      data-minimized-mount={hiddenMounted ? "hidden" : "visible"}
      data-presentation-mode={presentationMode ?? "default"}
      data-presentation-visibility={isPresentationHidden ? "hidden" : "visible"}
      data-slot="viewport-menu-boundary"
      data-workbench-node-type-id={resolveWorkbenchNodeTypeId(node.data)}
      data-workbench-window-id={node.id}
      data-window-drag-state={isDragging ? "dragging" : "idle"}
      data-window-resize-state={isResizing ? "resizing" : "idle"}
      style={{
        height: node.frame.height,
        left: node.frame.x,
        top: node.frame.y,
        transform: shellTransform,
        transformOrigin: "top left",
        width: node.frame.width,
        zIndex
      }}
      onPointerDown={
        hiddenMounted ||
        isPresentationHidden ||
        !interactive ||
        presentationMode === "mission-control"
          ? undefined
          : () => controller.commands.focusNode(node.id)
      }
    >
      <div className="workbench-window-shell__content">
        <div
          className="workbench-window"
          data-focused={isFocused ? "true" : "false"}
          data-display-mode={node.displayMode}
          data-fullscreen-header-mode={resolvedFullscreenHeaderMode}
          data-window-chrome-mode={resolvedHeader.windowChromeMode}
          data-workbench-window-capture="true"
          data-window-drag-state={isDragging ? "dragging" : "idle"}
          data-window-resize-state={isResizing ? "resizing" : "idle"}
        >
          <div
            className={[
              "workbench-window__header",
              shouldRenderCustomHeader
                ? "workbench-window__header--custom"
                : null
            ]
              .filter(Boolean)
              .join(" ")}
            onDoubleClick={
              shouldRenderCustomHeader || !interactive
                ? undefined
                : onHeaderDoubleClick
            }
            onPointerDown={
              shouldRenderCustomHeader || !interactive ? undefined : onDragStart
            }
          >
            {shouldRenderCustomHeader ? (
              resolvedHeader.customHeader
            ) : (
              <>
                {defaultActions}
                <div className="workbench-window__title">{node.title}</div>
              </>
            )}
          </div>
          <div className="workbench-window__body">{children}</div>
        </div>
        {node.displayMode === "floating" &&
        !hiddenMounted &&
        presentationMode !== "mission-control" &&
        interactive
          ? resizeHandles.map((handle) => (
              <ResizeHandle key={handle} handle={handle} node={node} />
            ))
          : null}
      </div>
      {presentationInteraction ? (
        <button
          aria-label={node.title}
          aria-pressed={
            presentationInteraction.mode === "layout"
              ? isMissionControlSelected
              : undefined
          }
          className="absolute inset-0 z-10 block appearance-none rounded-lg border-0 bg-transparent p-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            presentationInteraction.onNodePress(node.id);
          }}
        >
          {presentationInteraction.mode === "layout" &&
          isMissionControlSelected ? (
            <div className="pointer-events-none absolute inset-0 rounded-lg border-2 border-[var(--tutti-purple)] transition-[border-color,transform] duration-150 ease-out" />
          ) : null}
        </button>
      ) : null}
      {presentationInteraction?.mode === "layout" &&
      isMissionControlSelected ? (
        <Checkbox
          aria-hidden="true"
          checked
          className="pointer-events-none absolute right-3 bottom-3 z-20 size-6 rounded-md text-[var(--white-stationary)] shadow-[0_2px_8px_rgb(0_0_0_/_0.18)] data-[state=checked]:border-[var(--tutti-purple)] data-[state=checked]:bg-[var(--tutti-purple)] [&_[data-slot=checkbox-indicator]>svg]:size-4"
          tabIndex={-1}
        />
      ) : null}
    </section>
  );
}

function ResizeHandle<TData>({
  handle,
  node
}: {
  handle: WorkbenchResizeHandle;
  node: WorkbenchNode<TData>;
}) {
  const onPointerDown = useWorkbenchResize(node, handle);
  return (
    <div
      className="workbench-window__resize-handle"
      data-handle={handle}
      onPointerDown={onPointerDown}
    />
  );
}
