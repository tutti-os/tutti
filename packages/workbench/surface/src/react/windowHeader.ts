import type { ReactNode } from "react";
import type { WorkbenchNode } from "../core/types.ts";
import type { WorkbenchController } from "../store/types.ts";
import type {
  WorkbenchRenderWindowHeader,
  WorkbenchResolveWindowChromeMode,
  WorkbenchWindowChromeMode,
  WorkbenchWindowHeaderContext,
  WorkbenchWindowHeaderDragHandleProps
} from "./types.ts";

type WorkbenchHeaderGenieControls = {
  minimizeNodeToAnchor(nodeID: string, minimize?: () => void): void;
};

export interface ResolveWorkbenchWindowHeaderInput<TData = unknown> {
  controller: WorkbenchController<TData>;
  defaultActions: ReactNode;
  genie: WorkbenchHeaderGenieControls;
  isDragging: boolean;
  isFocused: boolean;
  isResizing: boolean;
  node: WorkbenchNode<TData>;
  onDoubleClick: WorkbenchWindowHeaderDragHandleProps["onDoubleClick"];
  onDragStart: WorkbenchWindowHeaderDragHandleProps["onPointerDown"];
  renderHeader?: WorkbenchRenderWindowHeader<TData>;
  renderRevision: object;
  windowChromeMode?: WorkbenchWindowChromeMode;
}

export interface ResolvedWorkbenchWindowHeader<TData = unknown> {
  context: WorkbenchWindowHeaderContext<TData>;
  customHeader: ReactNode | null;
  windowChromeMode: WorkbenchWindowChromeMode;
}

export function resolveWorkbenchWindowChromeMode<TData>({
  controller,
  node,
  windowChromeMode
}: {
  controller: WorkbenchController<TData>;
  node: WorkbenchNode<TData>;
  windowChromeMode?:
    | WorkbenchWindowChromeMode
    | WorkbenchResolveWindowChromeMode<TData>;
}): WorkbenchWindowChromeMode {
  if (typeof windowChromeMode === "function") {
    return windowChromeMode({ controller, node });
  }

  return windowChromeMode ?? "system";
}

export function resolveWorkbenchWindowHeader<TData>({
  controller,
  defaultActions,
  genie,
  isDragging,
  isFocused,
  isResizing,
  node,
  onDoubleClick,
  onDragStart,
  renderHeader,
  renderRevision,
  windowChromeMode = "system"
}: ResolveWorkbenchWindowHeaderInput<TData>): ResolvedWorkbenchWindowHeader<TData> {
  const context: WorkbenchWindowHeaderContext<TData> = {
    controller,
    defaultActions,
    dragHandleProps: {
      "data-workbench-drag-handle": "true",
      onDoubleClick,
      onPointerDown: onDragStart
    },
    genie,
    isDragging,
    isFocused,
    isResizing,
    node,
    renderRevision,
    surfaceSize: controller.getSnapshot().surfaceSize
  };

  const customHeader =
    windowChromeMode === "custom-header" && renderHeader
      ? renderHeader(context)
      : null;

  return {
    context,
    customHeader,
    windowChromeMode: customHeader === null ? "system" : "custom-header"
  };
}
