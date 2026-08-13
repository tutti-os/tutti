import type { WorkbenchHostProps } from "./types.ts";

export function logWorkbenchDockDebug(
  event: string,
  debugDiagnostics: WorkbenchHostProps["debugDiagnostics"],
  details: Record<string, unknown>
): void {
  if (!debugDiagnostics?.log) {
    return;
  }
  void Promise.resolve(
    debugDiagnostics.log({
      details,
      event,
      level: "info",
      source: "workbench-dock",
      workspaceId:
        typeof details.workspaceId === "string" ? details.workspaceId : null
    })
  ).catch(() => undefined);
}
