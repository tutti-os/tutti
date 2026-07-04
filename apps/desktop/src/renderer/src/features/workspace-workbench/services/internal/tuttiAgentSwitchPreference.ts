const tuttiAgentSwitchStorageKey =
  "tutti.workspaceSettings.tuttiAgentSwitchEnabled";

export interface TuttiAgentSwitchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveStorage(): TuttiAgentSwitchStorage | null {
  if (typeof globalThis.localStorage === "undefined") {
    return null;
  }
  return globalThis.localStorage;
}

export function readTuttiAgentSwitchEnabled(
  storage: TuttiAgentSwitchStorage | null = resolveStorage()
): boolean {
  try {
    return storage?.getItem(tuttiAgentSwitchStorageKey) === "1";
  } catch {
    return false;
  }
}

export function writeTuttiAgentSwitchEnabled(
  enabled: boolean,
  storage: TuttiAgentSwitchStorage | null = resolveStorage()
): void {
  try {
    storage?.setItem(tuttiAgentSwitchStorageKey, enabled ? "1" : "0");
  } catch {
    // Ignore persistence failures; keep the in-memory preference.
  }
}
