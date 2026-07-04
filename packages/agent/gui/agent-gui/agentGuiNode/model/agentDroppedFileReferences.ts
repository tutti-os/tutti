import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";

export type AgentDroppedFileReferenceResolver = (
  files: readonly File[]
) =>
  | Promise<readonly WorkspaceFileReference[]>
  | readonly WorkspaceFileReference[];
