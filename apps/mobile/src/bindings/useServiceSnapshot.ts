import { useSyncExternalStore } from "react";

export interface ExternalStore<TSnapshot> {
  getSnapshot(): TSnapshot;
  subscribe(listener: () => void): () => void;
}

export function useServiceSnapshot<TSnapshot>(
  service: ExternalStore<TSnapshot>
): TSnapshot {
  return useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );
}
