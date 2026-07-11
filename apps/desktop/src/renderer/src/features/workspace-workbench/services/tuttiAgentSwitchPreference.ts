const tuttiAgentSwitchStorageKey =
  "tutti.workspaceSettings.tuttiAgentSwitchEnabled";
const tuttiAgentSwitchMigrationStorageKey =
  "tutti.workspaceSettings.tuttiAgentSwitchDaemonMigrationV1";

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

export function readLegacyTuttiAgentSwitchEnabled(
  storage: TuttiAgentSwitchStorage | null = resolveStorage()
): boolean | null {
  try {
    const value = storage?.getItem(tuttiAgentSwitchStorageKey);
    return value === "1" ? true : value === "0" ? false : null;
  } catch {
    return null;
  }
}

export function hasMigratedTuttiAgentSwitchToDaemon(
  storage: TuttiAgentSwitchStorage | null = resolveStorage()
): boolean {
  try {
    return storage?.getItem(tuttiAgentSwitchMigrationStorageKey) === "1";
  } catch {
    return false;
  }
}

export function markTuttiAgentSwitchDaemonMigrationComplete(
  storage: TuttiAgentSwitchStorage | null = resolveStorage()
): void {
  try {
    storage?.setItem(tuttiAgentSwitchMigrationStorageKey, "1");
  } catch {
    // The daemon remains authoritative even when the optional marker cannot be stored.
  }
}
