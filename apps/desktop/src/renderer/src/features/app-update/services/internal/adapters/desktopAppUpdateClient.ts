import type { DesktopUpdateApi } from "@preload/types";
import type { AppUpdateState } from "@shared/contracts/ipc";

export interface DesktopAppUpdateClient {
  checkForUpdates(): Promise<AppUpdateState>;
  downloadUpdate(): Promise<AppUpdateState>;
  getState(): Promise<AppUpdateState>;
  installUpdate(): Promise<void>;
  onState(listener: (state: AppUpdateState) => void): () => void;
}

export interface DesktopAppUpdateClientDiagnostics {
  logStateNormalized?(details: Record<string, unknown>): void;
}

export function createDesktopAppUpdateClient(
  updateApi: DesktopUpdateApi,
  diagnostics: DesktopAppUpdateClientDiagnostics = {}
): DesktopAppUpdateClient {
  const normalize = (operation: string, value: unknown): AppUpdateState => {
    const updateState = unwrapAppUpdateState(value);
    diagnostics.logStateNormalized?.({
      operation,
      rawHasData: isObjectRecord(value) && "data" in value,
      rawKeys: isObjectRecord(value) ? Object.keys(value).sort() : [],
      rawOk: isObjectRecord(value) ? (value.ok ?? null) : null,
      normalizedCurrentVersion: updateState.currentVersion ?? null,
      normalizedLatestVersion: updateState.latestVersion ?? null,
      normalizedStatus: updateState.status ?? null
    });
    return updateState;
  };

  return {
    checkForUpdates() {
      return updateApi
        .checkForUpdates()
        .then((state) => normalize("checkForUpdates", state));
    },
    downloadUpdate() {
      return updateApi
        .downloadUpdate()
        .then((state) => normalize("downloadUpdate", state));
    },
    getState() {
      return updateApi.getState().then((state) => normalize("getState", state));
    },
    installUpdate() {
      return updateApi.installUpdate();
    },
    onState(listener: (state: AppUpdateState) => void) {
      return updateApi.onState((state) => {
        listener(normalize("onState", state));
      });
    }
  };
}

function unwrapAppUpdateState(value: unknown): AppUpdateState {
  let current = value;

  while (isObjectRecord(current) && !isAppUpdateState(current)) {
    if (isAppUpdateStateEnvelope(current) || "data" in current) {
      current = current.data;
      continue;
    }
    break;
  }

  return current as AppUpdateState;
}

function isAppUpdateStateEnvelope(
  value: unknown
): value is { ok: true; data: AppUpdateState } {
  return isObjectRecord(value) && value.ok === true && "data" in value;
}

function isAppUpdateState(value: unknown): value is AppUpdateState {
  return (
    isObjectRecord(value) &&
    typeof value.channel === "string" &&
    typeof value.currentVersion === "string" &&
    typeof value.policy === "string" &&
    typeof value.status === "string"
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
