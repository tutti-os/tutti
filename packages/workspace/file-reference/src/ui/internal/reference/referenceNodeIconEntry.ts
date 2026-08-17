import type { WorkspaceFileEntry } from "@tutti-os/workspace-file-manager";
import type { ReferenceNode } from "../../../contracts/referenceSource.ts";
import { base64UrlDecode } from "../../../core/index.ts";

export function referenceNodeToWorkspaceFileEntry(
  node: ReferenceNode
): WorkspaceFileEntry {
  return {
    hasChildren: node.kind === "folder",
    kind: node.kind === "folder" ? "directory" : "file",
    mtimeMs: node.mtimeMs ?? null,
    name: node.displayName,
    path: resolveReferenceNodeIconPath(node),
    sizeBytes: node.sizeBytes ?? null
  };
}

function resolveReferenceNodeIconPath(node: ReferenceNode): string {
  if (node.kind === "file" && node.ref.nodeId.startsWith("f:")) {
    try {
      return base64UrlDecode(node.ref.nodeId.slice(2));
    } catch {
      return node.ref.nodeId;
    }
  }
  return node.ref.nodeId;
}
