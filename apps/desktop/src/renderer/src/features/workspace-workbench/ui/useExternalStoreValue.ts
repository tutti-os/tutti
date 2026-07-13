import { useSyncExternalStore } from "react";

export function useExternalStoreValue<T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot: () => T = getSnapshot
): T {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
