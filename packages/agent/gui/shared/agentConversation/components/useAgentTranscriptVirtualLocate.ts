import { useCallback, useRef, type RefObject } from "react";
import {
  cancelUiAnimationFrame,
  requestUiAnimationFrame,
  scheduleUiTimeout
} from "./agentTranscriptPresentationScheduler";
import { agentTranscriptDistanceForTarget } from "./agentTranscriptScrollController";
import type {
  AgentTranscriptVirtualLayout,
  AgentTranscriptVirtualViewportState
} from "./agentTranscriptVirtualizerLayout";

const LOCATE_CORRECTION_THRESHOLD_PX = 24;
const LOCATE_CORRECTION_TIMEOUT_MS = 350;
const REVEAL_TIMEOUT_MS = 1_500;

export function useAgentTranscriptVirtualLocate(input: {
  activeLocateRef: RefObject<object | null>;
  applyDistance(distanceFromBottomPx: number, behavior?: ScrollBehavior): void;
  layoutRef: RefObject<AgentTranscriptVirtualLayout>;
  measuredElementsRef: RefObject<Map<string, HTMLElement>>;
  scrollElementRef: RefObject<HTMLElement | null>;
  scrollPaddingBottomRef: RefObject<number>;
  scrollPaddingTopRef: RefObject<number>;
  scrollToIndex(
    index: number,
    options: { align: "center" | "top"; behavior?: ScrollBehavior }
  ): void;
  setLocatingTurnKey(turnKey: string | null): void;
  viewportStateRef: RefObject<AgentTranscriptVirtualViewportState>;
  virtualizerHostRef: RefObject<HTMLDivElement | null>;
}) {
  const {
    applyDistance,
    activeLocateRef,
    layoutRef,
    measuredElementsRef,
    scrollElementRef,
    scrollPaddingBottomRef,
    scrollPaddingTopRef,
    scrollToIndex,
    setLocatingTurnKey,
    viewportStateRef,
    virtualizerHostRef
  } = input;
  const cancelCorrectionRef = useRef<(() => void) | null>(null);

  const alignMountedTarget = useCallback(
    (
      target: HTMLElement,
      align: "center" | "top",
      behavior: ScrollBehavior = "auto"
    ): HTMLElement => {
      const scrollElement = scrollElementRef.current;
      if (!scrollElement) return target;
      applyDistance(
        agentTranscriptDistanceForTarget({
          align,
          scrollElement,
          scrollPadding: {
            bottom: scrollPaddingBottomRef.current,
            top: scrollPaddingTopRef.current
          },
          target,
          viewportHeightPx: viewportStateRef.current.viewportHeightPx
        }),
        behavior
      );
      return target;
    },
    [
      applyDistance,
      scrollElementRef,
      scrollPaddingBottomRef,
      scrollPaddingTopRef,
      viewportStateRef
    ]
  );

  const scheduleMountedTargetCorrection = useCallback(
    (
      target: HTMLElement,
      align: "center" | "top",
      signal: AbortSignal | undefined
    ): void => {
      cancelCorrectionRef.current?.();
      cancelCorrectionRef.current = scheduleUiTimeout(() => {
        cancelCorrectionRef.current = null;
        const scrollElement = scrollElementRef.current;
        if (signal?.aborted || !target.isConnected || !scrollElement) return;
        const correctedDistance = agentTranscriptDistanceForTarget({
          align,
          scrollElement,
          scrollPadding: {
            bottom: scrollPaddingBottomRef.current,
            top: scrollPaddingTopRef.current
          },
          target,
          viewportHeightPx: viewportStateRef.current.viewportHeightPx
        });
        if (
          Math.abs(correctedDistance - Math.max(0, -scrollElement.scrollTop)) >
          LOCATE_CORRECTION_THRESHOLD_PX
        ) {
          applyDistance(correctedDistance);
        }
      }, LOCATE_CORRECTION_TIMEOUT_MS);
    },
    [
      applyDistance,
      scrollElementRef,
      scrollPaddingBottomRef,
      scrollPaddingTopRef,
      viewportStateRef
    ]
  );

  const scrollToKey = useCallback(
    async (
      turnKey: string,
      findTarget?: () => HTMLElement | null,
      options?: {
        align?: "center" | "top";
        behavior?: ScrollBehavior;
        signal?: AbortSignal;
      }
    ): Promise<HTMLElement | null> => {
      const host = virtualizerHostRef.current;
      if (options?.signal?.aborted || !host?.isConnected) return null;
      const index = layoutRef.current.turnIndexByKey.get(turnKey);
      if (index === undefined) return null;
      cancelCorrectionRef.current?.();
      cancelCorrectionRef.current = null;
      const locateOperation = {};
      activeLocateRef.current = locateOperation;
      setLocatingTurnKey(turnKey);
      const releaseLocateAfterLayout = (): void => {
        requestUiAnimationFrame(() => {
          if (activeLocateRef.current === locateOperation) {
            activeLocateRef.current = null;
            setLocatingTurnKey(null);
          }
        });
      };
      scrollToIndex(index, {
        align: options?.align ?? "top",
        behavior: options?.behavior
      });
      const findMountedTarget = () =>
        findTarget?.() ?? measuredElementsRef.current.get(turnKey) ?? null;
      const mountedTarget = findMountedTarget();
      if (mountedTarget) {
        const alignedTarget = alignMountedTarget(
          mountedTarget,
          options?.align ?? "top",
          options?.behavior
        );
        if (options?.behavior === "smooth") {
          scheduleMountedTargetCorrection(
            alignedTarget,
            options?.align ?? "top",
            options.signal
          );
        }
        releaseLocateAfterLayout();
        return alignedTarget;
      }
      const startedAt = performance.now();
      return new Promise((resolve) => {
        let frameId: number | null = null;
        let settled = false;
        const finish = (target: HTMLElement | null): void => {
          if (settled) return;
          settled = true;
          if (frameId !== null) cancelUiAnimationFrame(frameId);
          options?.signal?.removeEventListener("abort", abort);
          if (target) {
            if (options?.behavior === "smooth") {
              scheduleMountedTargetCorrection(
                target,
                options?.align ?? "top",
                options.signal
              );
            }
            releaseLocateAfterLayout();
          } else if (activeLocateRef.current === locateOperation) {
            activeLocateRef.current = null;
            setLocatingTurnKey(null);
          }
          resolve(target);
        };
        const abort = (): void => finish(null);
        const checkForMountedTarget = (): void => {
          if (options?.signal?.aborted || !host.isConnected) {
            finish(null);
            return;
          }
          const nextTarget = findMountedTarget();
          if (
            nextTarget ||
            performance.now() - startedAt >= REVEAL_TIMEOUT_MS
          ) {
            finish(
              nextTarget
                ? alignMountedTarget(
                    nextTarget,
                    options?.align ?? "top",
                    options?.behavior
                  )
                : null
            );
            return;
          }
          frameId = requestUiAnimationFrame(checkForMountedTarget);
        };
        options?.signal?.addEventListener("abort", abort, { once: true });
        checkForMountedTarget();
      });
    },
    [
      alignMountedTarget,
      activeLocateRef,
      layoutRef,
      measuredElementsRef,
      scheduleMountedTargetCorrection,
      scrollToIndex,
      setLocatingTurnKey,
      virtualizerHostRef
    ]
  );

  const cancelLocate = useCallback((): void => {
    activeLocateRef.current = null;
    setLocatingTurnKey(null);
    cancelCorrectionRef.current?.();
    cancelCorrectionRef.current = null;
  }, [activeLocateRef, setLocatingTurnKey]);

  return {
    cancelLocate,
    scrollToKey
  };
}
