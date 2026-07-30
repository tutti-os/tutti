import { useCallback, type RefObject } from "react";

export function useAgentMessageLocatorElementRef({
  cancelLocateOperation,
  closePanelTimeoutRef,
  locatorRef
}: {
  cancelLocateOperation(): void;
  closePanelTimeoutRef: RefObject<number | null>;
  locatorRef: RefObject<HTMLElement | null>;
}): (node: HTMLElement | null) => void {
  return useCallback(
    (node: HTMLElement | null): void => {
      locatorRef.current = node;
      if (node) return;
      if (closePanelTimeoutRef.current !== null) {
        window.clearTimeout(closePanelTimeoutRef.current);
      }
      cancelLocateOperation();
    },
    [cancelLocateOperation, closePanelTimeoutRef, locatorRef]
  );
}
