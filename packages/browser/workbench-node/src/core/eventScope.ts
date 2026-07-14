import type { BrowserNodeEvent } from "./types.ts";

export function getBrowserNodeEventNodeId(event: BrowserNodeEvent): string {
  return event.type === "open-url" ? event.sourceNodeId : event.nodeId;
}

export function isBrowserNodeSurfaceNodeId(
  surfaceNodeId: string,
  candidateNodeId: string
): boolean {
  return (
    candidateNodeId === surfaceNodeId ||
    candidateNodeId.startsWith(`${surfaceNodeId}:tab:`)
  );
}

export function isBrowserNodeSurfaceEvent(
  surfaceNodeId: string,
  event: BrowserNodeEvent
): boolean {
  return isBrowserNodeSurfaceNodeId(
    surfaceNodeId,
    getBrowserNodeEventNodeId(event)
  );
}
