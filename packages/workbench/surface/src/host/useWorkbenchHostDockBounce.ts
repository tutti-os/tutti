import { useCallback, useEffect, useRef, type RefObject } from "react";

const dockBounceMs = 600;

export const dockEntryClickThrottleMs = dockBounceMs;

export function useWorkbenchHostDockBounce(
  slotRefs: RefObject<Map<string, HTMLElement>>
) {
  const timeoutsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const clearDockBounce = useCallback(
    (anchorKey: string): boolean => {
      const timeout = timeoutsRef.current.get(anchorKey);
      const slotElement = slotRefs.current.get(anchorKey);
      const wasBouncing = slotElement?.hasAttribute("data-bouncing") === true;
      if (timeout) {
        clearTimeout(timeout);
        timeoutsRef.current.delete(anchorKey);
      }
      slotElement?.removeAttribute("data-bouncing");
      return wasBouncing;
    },
    [slotRefs]
  );

  useEffect(
    () => () => {
      for (const anchorKey of timeoutsRef.current.keys()) {
        clearDockBounce(anchorKey);
      }
      timeoutsRef.current.clear();
    },
    [clearDockBounce]
  );

  const triggerDockBounce = useCallback(
    (anchorKey: string) => {
      const shouldRestartAnimation = clearDockBounce(anchorKey);

      const slotElement = slotRefs.current.get(anchorKey);
      if (!slotElement) {
        return;
      }

      if (shouldRestartAnimation) {
        // Restart the CSS keyframes without scheduling a React render.
        void slotElement.offsetWidth;
      }
      slotElement.setAttribute("data-bouncing", "true");
      timeoutsRef.current.set(
        anchorKey,
        setTimeout(() => {
          clearDockBounce(anchorKey);
        }, dockBounceMs)
      );
    },
    [clearDockBounce, slotRefs]
  );

  return { triggerDockBounce };
}
