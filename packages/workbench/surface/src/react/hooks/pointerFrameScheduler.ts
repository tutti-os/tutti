interface PointerFrameScheduler {
  cancel(): void;
  flush(): void;
  schedule(event: PointerEvent): void;
}

export function createPointerFrameScheduler(
  onFrame: (event: PointerEvent) => void
): PointerFrameScheduler {
  let animationFrameID: number | null = null;
  let pendingEvent: PointerEvent | null = null;

  const dispatchPendingEvent = () => {
    const event = pendingEvent;
    pendingEvent = null;
    if (event) {
      onFrame(event);
    }
  };

  return {
    cancel() {
      if (animationFrameID !== null) {
        window.cancelAnimationFrame(animationFrameID);
        animationFrameID = null;
      }
      pendingEvent = null;
    },
    flush() {
      if (animationFrameID !== null) {
        window.cancelAnimationFrame(animationFrameID);
        animationFrameID = null;
      }
      dispatchPendingEvent();
    },
    schedule(event) {
      pendingEvent = event;
      if (animationFrameID !== null) {
        return;
      }
      animationFrameID = window.requestAnimationFrame(() => {
        animationFrameID = null;
        dispatchPendingEvent();
      });
    }
  };
}
