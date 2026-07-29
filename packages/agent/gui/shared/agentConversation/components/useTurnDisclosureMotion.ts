import { useCallback, useRef, useState } from "react";
import { findMessageLocatorScrollParent } from "./AgentMessageLocatorRail";

interface TurnDisclosureScrollAnchor {
  release: () => void;
}

class TurnDisclosureMotionController {
  private readonly movingTurnKeys = new Set<string>();
  private scrollAnchor: TurnDisclosureScrollAnchor | null = null;

  setTurnMotionActive(
    turnKey: string,
    active: boolean,
    anchorElement?: HTMLElement | null
  ): boolean {
    if (active) {
      this.movingTurnKeys.add(turnKey);
      if (anchorElement) {
        this.scrollAnchor?.release();
        this.scrollAnchor = lockDisclosureRowPosition(anchorElement);
      }
    } else {
      this.movingTurnKeys.delete(turnKey);
      if (this.movingTurnKeys.size === 0) {
        this.scrollAnchor?.release();
        this.scrollAnchor = null;
      }
    }
    return this.movingTurnKeys.size > 0;
  }
}

function lockDisclosureRowPosition(
  anchorElement: HTMLElement
): TurnDisclosureScrollAnchor | null {
  const scrollParent = findMessageLocatorScrollParent(anchorElement);
  if (!scrollParent) {
    return null;
  }

  const anchorTop = anchorElement.getBoundingClientRect().top;
  const previousOverflowAnchor =
    scrollParent.style.getPropertyValue("overflow-anchor");
  const previousOverflowAnchorPriority =
    scrollParent.style.getPropertyPriority("overflow-anchor");
  scrollParent.style.setProperty("overflow-anchor", "none");

  const preserveAnchorTop = (): void => {
    if (!anchorElement.isConnected) {
      return;
    }
    const topDelta = anchorElement.getBoundingClientRect().top - anchorTop;
    if (Math.abs(topDelta) < 0.5) {
      return;
    }
    scrollParent.scrollTop += topDelta;
  };
  scrollParent.addEventListener("scroll", preserveAnchorTop);

  return {
    release: () => {
      preserveAnchorTop();
      scrollParent.removeEventListener("scroll", preserveAnchorTop);
      if (previousOverflowAnchor) {
        scrollParent.style.setProperty(
          "overflow-anchor",
          previousOverflowAnchor,
          previousOverflowAnchorPriority
        );
      } else {
        scrollParent.style.removeProperty("overflow-anchor");
      }
    }
  };
}

export function useTurnDisclosureMotion(): readonly [
  active: boolean,
  setTurnMotionActive: (
    turnKey: string,
    active: boolean,
    anchorElement?: HTMLElement | null
  ) => void
] {
  const motionControllerRef = useRef<TurnDisclosureMotionController | null>(
    null
  );
  if (!motionControllerRef.current) {
    motionControllerRef.current = new TurnDisclosureMotionController();
  }
  const motionController = motionControllerRef.current;
  const [active, setActive] = useState(false);
  const setTurnMotionActive = useCallback(
    (turnKey: string, moving: boolean, anchorElement?: HTMLElement | null) => {
      setActive(
        motionController.setTurnMotionActive(turnKey, moving, anchorElement)
      );
    },
    [motionController]
  );

  return [active, setTurnMotionActive];
}
