import { resolveWorkspaceFileActivationTarget as resolveSharedWorkspaceFileActivationTarget } from "@tutti-os/workspace-file-preview";
import type {
  WorkspaceFileActivationTarget,
  WorkspaceFileEntry
} from "../../workspaceFileManagerTypes.ts";

export function resolveWorkspaceFileActivationTarget(
  entry: WorkspaceFileEntry
): WorkspaceFileActivationTarget | null {
  const target = resolveSharedWorkspaceFileActivationTarget(entry);
  if (!target) {
    return null;
  }

  return {
    fileKind: target.fileKind,
    mtimeMs: target.mtimeMs ?? null,
    name: target.name,
    path: target.path,
    sizeBytes: target.sizeBytes ?? null
  };
}
