import { useCallback, useEffect, useMemo, useRef } from "react";

export interface AgentTranscriptLocateOperation {
  begin(): AbortSignal;
  cancel(): void;
}

export function useAgentTranscriptLocateOperation(
  isVisible: boolean
): AgentTranscriptLocateOperation {
  const activeControllerRef = useRef<AbortController | null>(null);
  const cancel = useCallback((): void => {
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
  }, []);
  const begin = useCallback((): AbortSignal => {
    cancel();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    return controller.signal;
  }, [cancel]);

  useEffect(() => {
    if (!isVisible) cancel();
    return cancel;
  }, [cancel, isVisible]);

  return useMemo(() => ({ begin, cancel }), [begin, cancel]);
}
