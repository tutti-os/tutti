import type { WorkspaceWorkbenchSnapshotPersistence } from "./workspaceWorkbenchHostService.interface.ts";

export function resolveWorkspaceWorkbenchSnapshotPersistence(
  windowSearch: string
): WorkspaceWorkbenchSnapshotPersistence {
  return new URLSearchParams(windowSearch).get("view") === "agent"
    ? "window-local"
    : "durable";
}
