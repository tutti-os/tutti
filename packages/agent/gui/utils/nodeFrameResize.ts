import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { NodeFrame, Point, Size } from "../types";

export const NODE_DRAG_HANDLE_SELECTOR = "[data-node-drag-handle=true]";

export type ResizeEdge = "top" | "right" | "bottom" | "left";
export type ResizeEdges = Partial<Record<ResizeEdge, true>>;

interface ResizeStartState {
  client: Point;
  frame: NodeFrame;
  edges: ResizeEdges;
  aspectRatio: number | null;
}

function isSameFrame(left: NodeFrame, right: NodeFrame): boolean {
  return (
    left.position.x === right.position.x &&
    left.position.y === right.position.y &&
    left.size.width === right.size.width &&
    left.size.height === right.size.height
  );
}

export function normalizeResizePointerDelta(delta: Point, zoom: number): Point {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;

  return {
    x: delta.x / safeZoom,
    y: delta.y / safeZoom
  };
}

export function resolveResizedNodeFrame({
  initialFrame,
  edges,
  delta,
  minSize,
  aspectRatio
}: {
  initialFrame: NodeFrame;
  edges: ResizeEdges;
  delta: Point;
  minSize: Size;
  aspectRatio?: number | null;
}): NodeFrame {
  const isValidAspectRatio =
    typeof aspectRatio === "number" &&
    Number.isFinite(aspectRatio) &&
    aspectRatio > 0;

  if (isValidAspectRatio) {
    const hasHorizontal = Boolean(edges.left || edges.right);
    const hasVertical = Boolean(edges.top || edges.bottom);

    const rawWidth =
      edges.left && !edges.right
        ? initialFrame.size.width - delta.x
        : edges.right && !edges.left
          ? initialFrame.size.width + delta.x
          : initialFrame.size.width;

    const rawHeight =
      edges.top && !edges.bottom
        ? initialFrame.size.height - delta.y
        : edges.bottom && !edges.top
          ? initialFrame.size.height + delta.y
          : initialFrame.size.height;

    const fixedX =
      edges.left && !edges.right
        ? initialFrame.position.x + initialFrame.size.width
        : edges.right && !edges.left
          ? initialFrame.position.x
          : initialFrame.position.x + initialFrame.size.width / 2;

    const fixedY =
      edges.top && !edges.bottom
        ? initialFrame.position.y + initialFrame.size.height
        : edges.bottom && !edges.top
          ? initialFrame.position.y
          : initialFrame.position.y + initialFrame.size.height / 2;

    let nextWidth = rawWidth;
    let nextHeight = rawHeight;

    if (hasHorizontal && hasVertical) {
      const denom = aspectRatio * aspectRatio + 1;
      const projectedHeight = (aspectRatio * rawWidth + rawHeight) / denom;
      nextHeight = projectedHeight;
      nextWidth = aspectRatio * projectedHeight;
    } else if (hasHorizontal) {
      nextWidth = rawWidth;
      nextHeight = rawWidth / aspectRatio;
    } else if (hasVertical) {
      nextHeight = rawHeight;
      nextWidth = rawHeight * aspectRatio;
    }

    if (
      !Number.isFinite(nextWidth) ||
      !Number.isFinite(nextHeight) ||
      nextWidth <= 0 ||
      nextHeight <= 0
    ) {
      nextHeight = Math.max(minSize.height, minSize.width / aspectRatio);
      nextWidth = nextHeight * aspectRatio;
    }

    const scale = Math.max(
      minSize.width / nextWidth,
      minSize.height / nextHeight,
      1
    );
    nextWidth *= scale;
    nextHeight *= scale;

    const resolvedWidth = Math.max(minSize.width, Math.round(nextWidth));
    const resolvedHeight = Math.max(minSize.height, Math.round(nextHeight));

    const nextX =
      edges.left && !edges.right
        ? fixedX - resolvedWidth
        : edges.right && !edges.left
          ? fixedX
          : fixedX - resolvedWidth / 2;

    const nextY =
      edges.top && !edges.bottom
        ? fixedY - resolvedHeight
        : edges.bottom && !edges.top
          ? fixedY
          : fixedY - resolvedHeight / 2;

    return {
      position: {
        x: Math.round(nextX),
        y: Math.round(nextY)
      },
      size: {
        width: resolvedWidth,
        height: resolvedHeight
      }
    };
  }

  let nextX = initialFrame.position.x;
  let nextY = initialFrame.position.y;
  let nextWidth = initialFrame.size.width;
  let nextHeight = initialFrame.size.height;

  if (edges.right) {
    nextWidth = initialFrame.size.width + delta.x;
  }

  if (edges.left) {
    nextX = initialFrame.position.x + delta.x;
    nextWidth = initialFrame.size.width - delta.x;
  }

  if (edges.bottom) {
    nextHeight = initialFrame.size.height + delta.y;
  }

  if (edges.top) {
    nextY = initialFrame.position.y + delta.y;
    nextHeight = initialFrame.size.height - delta.y;
  }

  if (nextWidth < minSize.width) {
    if (edges.left && !edges.right) {
      nextX =
        initialFrame.position.x + (initialFrame.size.width - minSize.width);
    }

    nextWidth = minSize.width;
  }

  if (nextHeight < minSize.height) {
    if (edges.top && !edges.bottom) {
      nextY =
        initialFrame.position.y + (initialFrame.size.height - minSize.height);
    }

    nextHeight = minSize.height;
  }

  return {
    position: {
      x: Math.round(nextX),
      y: Math.round(nextY)
    },
    size: {
      width: Math.round(nextWidth),
      height: Math.round(nextHeight)
    }
  };
}

export function getNodeResizeCursor(edges: ResizeEdges): string {
  const { left, right, top, bottom } = edges;
  if ((left && top) || (right && bottom)) {
    return "nwse-resize";
  }

  if ((right && top) || (left && bottom)) {
    return "nesw-resize";
  }

  if (left || right) {
    return "ew-resize";
  }

  if (top || bottom) {
    return "ns-resize";
  }

  return "default";
}

export function useNodeFrameResize({
  position,
  width,
  height,
  minSize,
  aspectRatio,
  zoom = 1,
  onResize,
  onResizeStart,
  onResizeEnd
}: {
  position: Point;
  width: number;
  height: number;
  minSize: Size;
  aspectRatio?: number | null;
  zoom?: number;
  onResize: (frame: NodeFrame) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}): {
  draftFrame: NodeFrame | null;
  handleResizePointerDown: (
    edges: ResizeEdges
  ) => (event: ReactPointerEvent<HTMLElement>) => void;
} {
  const resizeStartRef = useRef<ResizeStartState | null>(null);
  const draftFrameRef = useRef<NodeFrame | null>(null);
  const pendingCommitFrameRef = useRef<NodeFrame | null>(null);
  const baseFrameAtResizeEndRef = useRef<NodeFrame | null>(null);
  const activeResizeCleanupRef = useRef<(() => void) | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [draftFrame, setDraftFrame] = useState<NodeFrame | null>(null);
  const zoomRef = useRef(zoom);
  const minSizeRef = useRef(minSize);
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);
  zoomRef.current = zoom;
  minSizeRef.current = minSize;
  onResizeRef.current = onResize;
  onResizeEndRef.current = onResizeEnd;
  draftFrameRef.current = draftFrame;

  useEffect(() => {
    return () => {
      activeResizeCleanupRef.current?.();
      activeResizeCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!draftFrame || isResizing) {
      return;
    }

    const baseFrame: NodeFrame = {
      position: { x: position.x, y: position.y },
      size: { width, height }
    };
    const pendingCommitFrame = pendingCommitFrameRef.current;
    if (pendingCommitFrame) {
      if (isSameFrame(baseFrame, pendingCommitFrame)) {
        pendingCommitFrameRef.current = null;
        baseFrameAtResizeEndRef.current = null;
        setDraftFrame(null);
        return;
      }

      const baseFrameAtResizeEnd = baseFrameAtResizeEndRef.current;
      if (
        baseFrameAtResizeEnd &&
        isSameFrame(baseFrame, baseFrameAtResizeEnd)
      ) {
        // Keep the visual preview until the resize commit lands in state to avoid flicker.
        return;
      }

      // If something else moved the node (for example Arrange) before the resize commit landed,
      // the draft frame would apply an incorrect relative transform and visually offset the node.
      pendingCommitFrameRef.current = null;
      baseFrameAtResizeEndRef.current = null;
      setDraftFrame(null);
      return;
    }

    if (
      draftFrame.position.x === position.x &&
      draftFrame.position.y === position.y &&
      draftFrame.size.width === width &&
      draftFrame.size.height === height
    ) {
      setDraftFrame(null);
    }
  }, [draftFrame, height, isResizing, position.x, position.y, width]);

  const handleResizePointerDown = useCallback(
    (edges: ResizeEdges) => (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);

      activeResizeCleanupRef.current?.();
      activeResizeCleanupRef.current = null;

      const frame: NodeFrame = {
        position: { ...position },
        size: { width, height }
      };

      pendingCommitFrameRef.current = null;
      baseFrameAtResizeEndRef.current = null;
      resizeStartRef.current = {
        client: {
          x: event.clientX,
          y: event.clientY
        },
        frame,
        edges,
        aspectRatio:
          typeof aspectRatio === "number" &&
          Number.isFinite(aspectRatio) &&
          aspectRatio > 0
            ? aspectRatio
            : null
      };

      draftFrameRef.current = frame;
      onResizeStart?.();
      setDraftFrame(frame);
      setIsResizing(true);

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        const start = resizeStartRef.current;
        if (!start) {
          return;
        }

        const nextFrame = resolveResizedNodeFrame({
          initialFrame: start.frame,
          edges: start.edges,
          delta: normalizeResizePointerDelta(
            {
              x: pointerEvent.clientX - start.client.x,
              y: pointerEvent.clientY - start.client.y
            },
            zoomRef.current
          ),
          minSize: minSizeRef.current,
          aspectRatio: start.aspectRatio
        });

        draftFrameRef.current = nextFrame;
        setDraftFrame(nextFrame);
      };

      let didFinalize = false;
      const finalizeResize = () => {
        if (didFinalize) {
          return;
        }

        didFinalize = true;
        activeResizeCleanupRef.current?.();

        setIsResizing(false);

        const finalFrame = draftFrameRef.current ?? frame;

        pendingCommitFrameRef.current = finalFrame;
        baseFrameAtResizeEndRef.current = {
          position: { x: position.x, y: position.y },
          size: { width, height }
        };

        onResizeRef.current(finalFrame);
        resizeStartRef.current = null;
        onResizeEndRef.current?.();
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", finalizeResize);
        window.removeEventListener("pointercancel", finalizeResize);
        activeResizeCleanupRef.current = null;
      };

      activeResizeCleanupRef.current = cleanup;

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", finalizeResize, { once: true });
      window.addEventListener("pointercancel", finalizeResize, { once: true });
    },
    [aspectRatio, height, onResizeStart, position, width]
  );

  return {
    draftFrame,
    handleResizePointerDown
  };
}
