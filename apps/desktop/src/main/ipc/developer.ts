import { shell } from "electron";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import {
  desktopIpcChannels,
  type DesktopDeveloperLogKind
} from "../../shared/contracts/ipc";
import { type DeveloperLogsService } from "../developerLogs";
import {
  createDesktopDeveloperLogsService,
  exportDesktopDeveloperLogsAndNotify
} from "../developerLogsDesktop.ts";
import type { DesktopHostPreferencesState } from "../desktopHostPreferences";
import { resolveDesktopDefaultsFromEnv } from "../defaults";
import { registerDesktopIpcHandler } from "./handle.ts";

export function registerDeveloperIpc(
  preferences: DesktopHostPreferencesState,
  tuttidClient?: Pick<
    TuttidClient,
    | "listWorkspaceAgentSessionMessages"
    | "listWorkspaceAgentSessions"
    | "listWorkspaceAppFactoryJobs"
    | "listWorkspaceApps"
    | "listWorkspaces"
  >
): void {
  const defaults = resolveDesktopDefaultsFromEnv();
  const service = createDesktopDeveloperLogsService(preferences, tuttidClient);

  registerDesktopIpcHandler(desktopIpcChannels.developer.getLogsState, () =>
    service.getLogsState()
  );
  registerDesktopIpcHandler(desktopIpcChannels.developer.clearLogs, () =>
    service.clearLogs()
  );
  registerDesktopIpcHandler(desktopIpcChannels.developer.exportLogs, () =>
    exportDesktopDeveloperLogsAndNotify(preferences, tuttidClient)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.developer.openLogDirectory,
    async () => {
      await openPathOrThrow(defaults.state.logsDir);
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.developer.openLogFile,
    async (_event, kind: DesktopDeveloperLogKind) => {
      await openPathOrThrow(resolveLogFilePath(kind, service, defaults));
    }
  );
}

function resolveLogFilePath(
  kind: DesktopDeveloperLogKind,
  _service: DeveloperLogsService,
  defaults: ReturnType<typeof resolveDesktopDefaultsFromEnv>
): string {
  return kind === "daemon"
    ? defaults.state.tuttidLogPath
    : defaults.state.desktopLogPath;
}

async function openPathOrThrow(path: string): Promise<void> {
  const error = await shell.openPath(path);
  if (error) {
    throw new Error(error);
  }
}
