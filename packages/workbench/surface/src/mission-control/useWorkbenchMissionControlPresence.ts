import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { WorkbenchMissionControlState } from "./useWorkbenchMissionControlState.ts";

export type WorkbenchMissionControlPhase =
  | "closed"
  | "entering"
  | "open"
  | "closing";

export interface WorkbenchMissionControlPresence {
  completeExitTransition(): void;
  phase: WorkbenchMissionControlPhase;
  state: WorkbenchMissionControlState | null;
}

export function useWorkbenchMissionControlPresence(
  state: WorkbenchMissionControlState | null
): WorkbenchMissionControlPresence {
  const [renderedState, setRenderedState] =
    useState<WorkbenchMissionControlState | null>(state);
  const [phase, setPhase] = useState<WorkbenchMissionControlPhase>(
    state ? "open" : "closed"
  );
  const phaseRef = useRef<WorkbenchMissionControlPhase>(
    state ? "open" : "closed"
  );
  const enterFrameRef = useRef<number | null>(null);
  const setPresencePhase = useCallback(
    (nextPhase: WorkbenchMissionControlPhase) => {
      if (phaseRef.current === nextPhase) {
        return;
      }
      phaseRef.current = nextPhase;
      setPhase(nextPhase);
    },
    []
  );
  const completeExitTransition = useCallback(() => {
    if (phaseRef.current !== "closing") {
      return;
    }
    setRenderedState(null);
    setPresencePhase("closed");
  }, [setPresencePhase]);

  useLayoutEffect(() => {
    if (enterFrameRef.current !== null) {
      window.cancelAnimationFrame(enterFrameRef.current);
      enterFrameRef.current = null;
    }

    if (state) {
      setRenderedState(state);
      if (phaseRef.current === "closed" || phaseRef.current === "closing") {
        setPresencePhase("entering");
      }
      enterFrameRef.current = window.requestAnimationFrame(() => {
        setPresencePhase("open");
        enterFrameRef.current = null;
      });

      return () => {
        if (enterFrameRef.current !== null) {
          window.cancelAnimationFrame(enterFrameRef.current);
          enterFrameRef.current = null;
        }
      };
    }

    if (renderedState === null) {
      setPresencePhase("closed");
      return undefined;
    }

    setPresencePhase("closing");
    return undefined;
  }, [renderedState, setPresencePhase, state]);

  return {
    completeExitTransition,
    phase,
    state: renderedState
  };
}
