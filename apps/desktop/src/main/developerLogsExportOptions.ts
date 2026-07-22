import type {
  DesktopDeveloperLogsExportScope,
  ExportDeveloperLogsInput
} from "../shared/contracts/ipc.ts";
import type { DeveloperLogsTimeWindow } from "./developerLogsRecentWindow.ts";

const developerLogsWindowMs: Record<DesktopDeveloperLogsExportScope, number> = {
  "recent-10-minutes": 10 * 60 * 1_000,
  "recent-3-days": 3 * 24 * 60 * 60 * 1_000
};

export function normalizeDeveloperLogsExportInput(
  input: unknown
): ExportDeveloperLogsInput {
  const candidate =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  return {
    includeAgentSessions: candidate.includeAgentSessions !== false,
    scope:
      candidate.scope === "recent-10-minutes"
        ? "recent-10-minutes"
        : "recent-3-days"
  };
}

export function resolveDeveloperLogsTimeWindow(
  scope: DesktopDeveloperLogsExportScope,
  exportedAt: Date
): DeveloperLogsTimeWindow {
  return {
    endTimeUnixMs: exportedAt.getTime(),
    startTimeUnixMs: exportedAt.getTime() - developerLogsWindowMs[scope]
  };
}

export function createDefaultDeveloperLogsExportFileName(input: {
  exportedAt: Date;
  includeAgentSessions: boolean;
  scope: DesktopDeveloperLogsExportScope;
}): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const { exportedAt } = input;
  const stamp = `${exportedAt.getFullYear()}${pad(exportedAt.getMonth() + 1)}${pad(exportedAt.getDate())}-${pad(
    exportedAt.getHours()
  )}${pad(exportedAt.getMinutes())}${pad(exportedAt.getSeconds())}`;
  const rangeSegment =
    input.scope === "recent-10-minutes" ? "last-10-minutes" : "last-3-days";
  const sessionSegment = input.includeAgentSessions ? "-with-sessions" : "";
  return `tutti-logs-${rangeSegment}${sessionSegment}-${stamp}.zip`;
}
