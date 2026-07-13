const tuttiAgentSwitchStorageKey =
  "tutti.workspaceSettings.tuttiAgentSwitchEnabled";
const tuttiAgentSwitchMigrationStorageKey =
  "tutti.workspaceSettings.tuttiAgentSwitchDaemonMigrationV1";

export interface TuttiAgentSwitchStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export type LegacyTuttiAgentSwitchReadResult =
  | { status: "error" }
  | { status: "missing" }
  | { enabled: boolean; status: "value" };

function resolveStorage(): TuttiAgentSwitchStorage | null {
  if (typeof globalThis.localStorage === "undefined") {
    return null;
  }
  return globalThis.localStorage;
}

export function readLegacyTuttiAgentSwitchEnabled(
  storage: TuttiAgentSwitchStorage | null = resolveStorage()
): LegacyTuttiAgentSwitchReadResult {
  try {
    if (!storage) {
      return { status: "missing" };
    }
    const value = storage?.getItem(tuttiAgentSwitchStorageKey);
    return value === "1"
      ? { enabled: true, status: "value" }
      : value === "0"
        ? { enabled: false, status: "value" }
        : { status: "missing" };
  } catch {
    return { status: "error" };
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
): boolean {
  try {
    if (!storage) {
      return true;
    }
    storage.setItem(tuttiAgentSwitchMigrationStorageKey, "1");
    return true;
  } catch {
    return false;
  }
}

export function clearTuttiAgentSwitchDaemonMigration(
  storage: TuttiAgentSwitchStorage | null = resolveStorage()
): void {
  try {
    storage?.removeItem(tuttiAgentSwitchMigrationStorageKey);
  } catch {
    // A failed rollback may skip the legacy migration, but cannot overwrite daemon state.
  }
}
