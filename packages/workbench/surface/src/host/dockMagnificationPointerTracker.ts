export interface DockMagnificationPointerTrackingTarget {
  addEventListener: EventTarget["addEventListener"];
  removeEventListener: EventTarget["removeEventListener"];
}

export interface DockMagnificationGlobalPointerTracker {
  isActive: () => boolean;
  start: () => void;
  stop: () => void;
}

export const dockMagnificationPointerListenerOptions = {
  capture: true,
  passive: true
} as const;

export function createDockMagnificationGlobalPointerTracker({
  blurTarget,
  onPointerCancel,
  onPointerMove,
  pointerTarget
}: {
  blurTarget: DockMagnificationPointerTrackingTarget | null;
  onPointerCancel: () => void;
  onPointerMove: (clientX: number, clientY: number) => void;
  pointerTarget: DockMagnificationPointerTrackingTarget;
}): DockMagnificationGlobalPointerTracker {
  let active = false;

  const handlePointerMove = (event: Event) => {
    const pointerEvent = event as PointerEvent;
    onPointerMove(pointerEvent.clientX, pointerEvent.clientY);
  };

  const handlePointerCancel = () => {
    stop();
    onPointerCancel();
  };

  const start = () => {
    if (active) {
      return;
    }
    active = true;
    pointerTarget.addEventListener(
      "pointermove",
      handlePointerMove,
      dockMagnificationPointerListenerOptions
    );
    pointerTarget.addEventListener(
      "pointercancel",
      handlePointerCancel,
      dockMagnificationPointerListenerOptions
    );
    blurTarget?.addEventListener("blur", handlePointerCancel);
  };

  const stop = () => {
    if (!active) {
      return;
    }
    active = false;
    pointerTarget.removeEventListener(
      "pointermove",
      handlePointerMove,
      dockMagnificationPointerListenerOptions
    );
    pointerTarget.removeEventListener(
      "pointercancel",
      handlePointerCancel,
      dockMagnificationPointerListenerOptions
    );
    blurTarget?.removeEventListener("blur", handlePointerCancel);
  };

  return {
    isActive: () => active,
    start,
    stop
  };
}
