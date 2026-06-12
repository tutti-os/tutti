import type { HTMLAttributes, ReactNode } from "react";
import type { WorkbenchController } from "../store/types.ts";
import type {
  WorkbenchFrame,
  WorkbenchNode,
  WorkbenchSize
} from "../core/types.ts";

export interface WorkbenchNodeRenderFrame {
  frame: WorkbenchFrame;
  zIndex: number;
  isFocused: boolean;
  presentation?: WorkbenchSurfacePresentation | null;
}

export interface WorkbenchSurfacePresentation {
  frameByNodeId: ReadonlyMap<string, WorkbenchFrame>;
  interaction?: WorkbenchSurfacePresentationInteraction | null;
  mode: "mission-control";
}

export interface WorkbenchSurfacePresentationInteraction {
  mode: "activate" | "layout";
  onBackdropPress: () => void;
  onNodePress(nodeId: string): void;
  selectedNodeIds: ReadonlySet<string>;
}

export interface WorkbenchRenderNodeContext<TData = unknown> {
  node: WorkbenchNode<TData>;
  layout: WorkbenchNodeRenderFrame;
  controller: WorkbenchController<TData>;
}

export interface WorkbenchDockContext<TData = unknown> {
  focusedNodeId: string | null;
  minimizedNodes: readonly WorkbenchNode<TData>[];
  nodes: readonly WorkbenchNode<TData>[];
  controller: WorkbenchController<TData>;
  genie: {
    launchNodeFromAnchor(
      anchorKey: string,
      nodeID: string,
      launch: () => Promise<string | null | void> | string | null | void
    ): void;
    registerDockAnchor(anchorKey: string, element: HTMLElement | null): void;
    shouldAnimateMinimizedDockEnter(nodeID: string): boolean;
  };
}

export type WorkbenchDockPlacement = "bottom" | "left";

export interface WorkbenchWindowActionContext<TData = unknown> {
  node: WorkbenchNode<TData>;
  controller: WorkbenchController<TData>;
  genie: {
    minimizeNodeToAnchor(nodeID: string, minimize?: () => void): void;
  };
}

export type WorkbenchWindowChromeMode = "system" | "custom-header";

export type WorkbenchFullscreenHeaderMode = "persistent" | "reveal";

export interface WorkbenchResolveWindowChromeModeContext<TData = unknown> {
  node: WorkbenchNode<TData>;
  controller: WorkbenchController<TData>;
}

export type WorkbenchResolveWindowChromeMode<TData = unknown> = (
  context: WorkbenchResolveWindowChromeModeContext<TData>
) => WorkbenchWindowChromeMode;

export type WorkbenchResolveFullscreenHeaderMode<TData = unknown> = (
  context: WorkbenchResolveWindowChromeModeContext<TData>
) => WorkbenchFullscreenHeaderMode | undefined;

export type WorkbenchKeepMinimizedNodeMounted<TData = unknown> = (
  node: WorkbenchNode<TData>
) => boolean;

export interface WorkbenchWindowHeaderDragHandleProps {
  "data-workbench-drag-handle": "true";
  onDoubleClick: HTMLAttributes<HTMLElement>["onDoubleClick"];
  onPointerDown: HTMLAttributes<HTMLElement>["onPointerDown"];
}

export interface WorkbenchWindowHeaderContext<TData = unknown> {
  node: WorkbenchNode<TData>;
  controller: WorkbenchController<TData>;
  surfaceSize: WorkbenchSize;
  genie: {
    minimizeNodeToAnchor(nodeID: string, minimize?: () => void): void;
  };
  defaultActions: ReactNode;
  dragHandleProps: WorkbenchWindowHeaderDragHandleProps;
}

export type WorkbenchRenderNode<TData = unknown> = (
  context: WorkbenchRenderNodeContext<TData>
) => ReactNode;

export type WorkbenchRenderWindowActions<TData = unknown> = (
  context: WorkbenchWindowActionContext<TData>
) => ReactNode;

export type WorkbenchRenderWindowHeader<TData = unknown> = (
  context: WorkbenchWindowHeaderContext<TData>
) => ReactNode;
