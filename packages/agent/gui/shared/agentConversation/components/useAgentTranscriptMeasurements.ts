import { useCallback, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useElementResizeObserver } from "@tutti-os/ui-react-hooks";

interface AgentTranscriptMeasurements {
  disconnect(): void;
  measureElement(turnKey: string, element: HTMLElement | null): void;
  measuredElementsRef: RefObject<Map<string, HTMLElement>>;
  measuredHeightsByKey: Readonly<Record<string, number>>;
  measuredHeightsRef: RefObject<Readonly<Record<string, number>>>;
  syncMountedElements(): boolean;
}

export function useAgentTranscriptMeasurements(
  initialHeightsByKey: Readonly<Record<string, number>>,
  onBeforeMeasurementsCommit?: () => void,
  onMeasurementsCommit?: (
    nextHeightsByKey: Readonly<Record<string, number>>
  ) => void
): AgentTranscriptMeasurements {
  const [measuredHeightsByKey, setMeasuredHeightsByKey] =
    useState<Readonly<Record<string, number>>>(initialHeightsByKey);
  const measuredHeightsRef = useRef(measuredHeightsByKey);
  const measuredElementsRef = useRef(new Map<string, HTMLElement>());
  const pendingMeasurementsRef = useRef(
    new Map<string, { element: HTMLElement; heightPx: number }>()
  );
  const mountedElementsPendingSyncMeasureRef = useRef(
    new Map<string, HTMLElement>()
  );
  const measurementCommitScheduledRef = useRef(false);
  const resizeObservation = useElementResizeObserver();
  const beforeCommitRef = useRef(onBeforeMeasurementsCommit);
  const commitRef = useRef(onMeasurementsCommit);
  beforeCommitRef.current = onBeforeMeasurementsCommit;
  commitRef.current = onMeasurementsCommit;
  measuredHeightsRef.current = measuredHeightsByKey;

  const commitMeasurements = useCallback(
    (
      pendingMeasurements: ReadonlyMap<
        string,
        { element: HTMLElement; heightPx: number }
      >,
      synchronously: boolean
    ): boolean => {
      let nextMeasurements: Record<string, number> | null = null;
      for (const [key, measurement] of pendingMeasurements) {
        if (measuredElementsRef.current.get(key) !== measurement.element) {
          continue;
        }
        const currentMeasurements =
          nextMeasurements ?? measuredHeightsRef.current;
        if (currentMeasurements[key] === measurement.heightPx) {
          continue;
        }
        nextMeasurements ??= { ...measuredHeightsRef.current };
        nextMeasurements[key] = measurement.heightPx;
      }
      if (!nextMeasurements) return false;
      const commit = (): void => {
        commitRef.current?.(nextMeasurements);
        measuredHeightsRef.current = nextMeasurements;
        setMeasuredHeightsByKey(nextMeasurements);
      };
      if (synchronously) {
        flushSync(commit);
      } else {
        commit();
      }
      return true;
    },
    []
  );

  const commitPendingMeasurements = useCallback((): void => {
    measurementCommitScheduledRef.current = false;
    const pendingMeasurements = pendingMeasurementsRef.current;
    pendingMeasurementsRef.current = new Map();
    commitMeasurements(pendingMeasurements, true);
  }, [commitMeasurements]);

  const scheduleMeasurement = useCallback(
    (key: string, element: HTMLElement, heightPx: number): void => {
      if (heightPx <= 0) return;
      beforeCommitRef.current?.();
      pendingMeasurementsRef.current.set(key, { element, heightPx });
      if (measurementCommitScheduledRef.current) return;
      measurementCommitScheduledRef.current = true;
      queueMicrotask(commitPendingMeasurements);
    },
    [commitPendingMeasurements]
  );

  const measureElement = useCallback(
    (turnKey: string, element: HTMLElement | null): void => {
      const previous = measuredElementsRef.current.get(turnKey);
      if (previous && previous !== element) {
        resizeObservation.unobserve(previous);
      }
      if (!element) {
        measuredElementsRef.current.delete(turnKey);
        pendingMeasurementsRef.current.delete(turnKey);
        mountedElementsPendingSyncMeasureRef.current.delete(turnKey);
        return;
      }
      measuredElementsRef.current.set(turnKey, element);
      mountedElementsPendingSyncMeasureRef.current.set(turnKey, element);
      resizeObservation.observe(element, (observation) => {
        const height = Math.ceil(
          observation.borderBoxSize?.[0]?.blockSize ??
            observation.contentRect.height
        );
        scheduleMeasurement(turnKey, observation.target as HTMLElement, height);
      });
    },
    [resizeObservation, scheduleMeasurement]
  );

  const disconnect = useCallback((): void => {
    resizeObservation.disconnect();
    measuredElementsRef.current.clear();
    pendingMeasurementsRef.current.clear();
    mountedElementsPendingSyncMeasureRef.current.clear();
    measurementCommitScheduledRef.current = false;
  }, [resizeObservation]);

  const syncMountedElements = useCallback((): boolean => {
    const pendingElements = mountedElementsPendingSyncMeasureRef.current;
    mountedElementsPendingSyncMeasureRef.current = new Map();
    const measurements = new Map<
      string,
      { element: HTMLElement; heightPx: number }
    >();
    for (const [key, element] of pendingElements) {
      if (measuredElementsRef.current.get(key) !== element) continue;
      const heightPx = Math.ceil(element.offsetHeight);
      if (heightPx > 0) measurements.set(key, { element, heightPx });
    }
    if (measurements.size === 0) return false;
    if (!commitMeasurements(measurements, false)) return false;
    for (const [key, element] of pendingElements) {
      if (measuredElementsRef.current.get(key) === element) {
        mountedElementsPendingSyncMeasureRef.current.set(key, element);
      }
    }
    return true;
  }, [commitMeasurements]);

  return {
    disconnect,
    measureElement,
    measuredElementsRef,
    measuredHeightsByKey,
    measuredHeightsRef,
    syncMountedElements
  };
}
