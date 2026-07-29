import {
  desktopIpcChannels,
  type ClearDeveloperLogsResult,
  type DesktopDeveloperLogKind,
  type DesktopDeveloperLogsState,
  type ExportDeveloperLogsInput,
  type ExportDeveloperLogsResult
} from "../../shared/contracts/ipc";
import type { DesktopDeveloperApi } from "../types";
import { invokeDesktopApi } from "./invoke";

export function createDeveloperDesktopApi(): DesktopDeveloperApi {
  return {
    clearLogs(): Promise<ClearDeveloperLogsResult> {
      return invokeDesktopApi(desktopIpcChannels.developer.clearLogs);
    },
    exportLogs(
      input: ExportDeveloperLogsInput
    ): Promise<ExportDeveloperLogsResult> {
      return invokeDesktopApi(desktopIpcChannels.developer.exportLogs, input);
    },
    getLogsState(): Promise<DesktopDeveloperLogsState> {
      return invokeDesktopApi(desktopIpcChannels.developer.getLogsState);
    },
    openLogDirectory(): Promise<void> {
      return invokeDesktopApi(desktopIpcChannels.developer.openLogDirectory);
    },
    openLogFile(kind: DesktopDeveloperLogKind): Promise<void> {
      return invokeDesktopApi(desktopIpcChannels.developer.openLogFile, kind);
    }
  };
}
