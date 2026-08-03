import { type MouseEvent, type PointerEvent, useRef } from "react";

export interface PrimaryPointerAction {
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
}

/**
 * Runs mouse actions before a surrounding Popover can dismiss, while leaving
 * touch and pen activation cancellable until the browser emits a click.
 */
export function usePrimaryPointerAction(
  action: () => void
): PrimaryPointerAction {
  const mouseActionRequestedRef = useRef(false);

  return {
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      if (event.pointerType && event.pointerType !== "mouse") {
        mouseActionRequestedRef.current = false;
        return;
      }
      mouseActionRequestedRef.current = true;
      event.preventDefault();
      action();
    },
    onClick: (event) => {
      if (event.detail === 0) {
        action();
        return;
      }
      if (mouseActionRequestedRef.current) {
        mouseActionRequestedRef.current = false;
        return;
      }
      action();
    }
  };
}
