import {
  resolveWorkspaceFileVisualKind,
  type WorkspaceFileVisualKind
} from "@tutti-os/workspace-file-preview";

export type AgentWorkspaceFileVisualKind =
  | Exclude<WorkspaceFileVisualKind, "directory">
  | "folder";

export function resolveAgentWorkspaceFileVisualKind(
  pathOrName: string,
  options: { refType?: string } = {}
): AgentWorkspaceFileVisualKind {
  const refType = options.refType;
  const kind = resolveWorkspaceFileVisualKind({
    kind:
      refType === "folder" || refType === "directory" ? "directory" : "file",
    name: pathOrName,
    path: pathOrName
  });
  return kind === "directory" ? "folder" : kind;
}
