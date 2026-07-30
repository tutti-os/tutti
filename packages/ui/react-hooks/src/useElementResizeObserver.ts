import { useCallback, useMemo, useRef } from "react";

export interface ElementResizeObservation {
  disconnect(): void;
  observe(
    element: Element,
    onResize: (entry: ResizeObserverEntry) => void
  ): () => void;
  unobserve(element: Element): void;
}

export function useElementResizeObserver(): ElementResizeObservation {
  const handlersRef = useRef(
    new Map<Element, (entry: ResizeObserverEntry) => void>()
  );
  const observerRef = useRef<ResizeObserver | null>(null);
  const ensureObserver = useCallback((): ResizeObserver | null => {
    if (!observerRef.current && typeof ResizeObserver === "function") {
      observerRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          handlersRef.current.get(entry.target)?.(entry);
        }
      });
    }
    return observerRef.current;
  }, []);
  const unobserve = useCallback((element: Element): void => {
    handlersRef.current.delete(element);
    observerRef.current?.unobserve(element);
  }, []);
  const disconnect = useCallback((): void => {
    handlersRef.current.clear();
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);
  const observe = useCallback(
    (
      element: Element,
      onResize: (entry: ResizeObserverEntry) => void
    ): (() => void) => {
      handlersRef.current.set(element, onResize);
      ensureObserver()?.observe(element);
      return () => unobserve(element);
    },
    [ensureObserver, unobserve]
  );

  return useMemo(
    () => ({ disconnect, observe, unobserve }),
    [disconnect, observe, unobserve]
  );
}
