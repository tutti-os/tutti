import { useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { WorkbenchNode, WorkbenchResizeHandle } from "../../core/types.ts";
import { useWorkbenchController } from "../WorkbenchProvider.tsx";
import { createPointerFrameScheduler } from "./pointerFrameScheduler.ts";

export function useWorkbenchResize<TData>(
  node: WorkbenchNode<TData>,
  handle: WorkbenchResizeHandle
) {
  const controller = useWorkbenchController<TData>();

  return useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      controller.commands.focusNode(node.id);
      controller.commands.setActiveResizeNode(node.id);

      const origin = { x: event.clientX, y: event.clientY };
      const initialFrame = node.frame;

      const pointerFrames = createPointerFrameScheduler((moveEvent) => {
        const deltaX = moveEvent.clientX - origin.x;
        const deltaY = moveEvent.clientY - origin.y;
        controller.commands.resizeNode(
          node.id,
          resizeFrame(initialFrame, handle, deltaX, deltaY)
        );
      });

      const onPointerMove = (moveEvent: PointerEvent) => {
        pointerFrames.schedule(moveEvent);
      };

      const cleanup = () => {
        pointerFrames.cancel();
        controller.commands.setActiveResizeNode(null);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", finishResize);
        window.removeEventListener("pointercancel", finishResize);
      };

      const finishResize = () => {
        pointerFrames.flush();
        cleanup();
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", finishResize);
      window.addEventListener("pointercancel", finishResize);
    },
    [controller, handle, node.frame, node.id]
  );
}

function resizeFrame(
  frame: WorkbenchNode["frame"],
  handle: WorkbenchResizeHandle,
  deltaX: number,
  deltaY: number
): WorkbenchNode["frame"] {
  const next = { ...frame };
  if (handle.includes("east")) {
    next.width += deltaX;
  }
  if (handle.includes("south")) {
    next.height += deltaY;
  }
  if (handle.includes("west")) {
    next.x += deltaX;
    next.width -= deltaX;
  }
  if (handle.includes("north")) {
    next.y += deltaY;
    next.height -= deltaY;
  }
  return next;
}
