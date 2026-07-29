import { useCallback, useSyncExternalStore } from "react";
import type { ExternalStoreSnapshotSource } from "./types.ts";

export function useExternalStoreSnapshot<TSnapshot>(
  source: ExternalStoreSnapshotSource<TSnapshot>
): TSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(listener),
    [source]
  );
  const getSnapshot = useCallback(() => source.getSnapshot(), [source]);
  const getServerSnapshot = useCallback(
    () => (source.getServerSnapshot ?? source.getSnapshot)(),
    [source]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
