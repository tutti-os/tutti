import { resolveWorkspaceFilePreviewTarget } from "@tutti-os/workspace-file-preview";
import type {
  WorkspaceFileActivationTarget,
  WorkspaceFileEntry
} from "../../workspaceFileManagerTypes.ts";

/**
 * Host activation adapter over the shared preview target vocabulary.
 * Open / reveal / open-with remain file-manager / desktop concerns.
 */
export function resolveWorkspaceFileActivationTarget(
  entry: WorkspaceFileEntry
): WorkspaceFileActivationTarget | null {
  const target = resolveWorkspaceFilePreviewTarget(entry);
  if (!target) {
    return null;
  }

  return {
    previewKind: target.previewKind,
    mtimeMs: target.mtimeMs ?? null,
    name: target.name,
    path: target.path,
    sizeBytes: target.sizeBytes ?? null
  };
}
