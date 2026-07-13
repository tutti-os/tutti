const openOwnersByNodeId = new Map<string, Set<string>>();
const listenersByNodeId = new Map<string, Set<() => void>>();

export function isBrowserNodeHostOverlayOpen(nodeId: string): boolean {
  return (openOwnersByNodeId.get(nodeId)?.size ?? 0) > 0;
}

export function setBrowserNodeHostOverlayOwnerOpen(input: {
  nodeId: string;
  open: boolean;
  ownerId: string;
}): void {
  const wasOpen = isBrowserNodeHostOverlayOpen(input.nodeId);
  const owners = openOwnersByNodeId.get(input.nodeId) ?? new Set<string>();

  if (input.open) {
    owners.add(input.ownerId);
    openOwnersByNodeId.set(input.nodeId, owners);
  } else {
    owners.delete(input.ownerId);
    if (owners.size === 0) {
      openOwnersByNodeId.delete(input.nodeId);
    }
  }

  if (wasOpen !== isBrowserNodeHostOverlayOpen(input.nodeId)) {
    for (const listener of listenersByNodeId.get(input.nodeId) ?? []) {
      listener();
    }
  }
}

export function subscribeBrowserNodeHostOverlay(
  nodeId: string,
  listener: () => void
): () => void {
  const listeners = listenersByNodeId.get(nodeId) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByNodeId.set(nodeId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersByNodeId.delete(nodeId);
    }
  };
}
