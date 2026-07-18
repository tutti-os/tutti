import { resolveAgentWorkspaceFileVisualKind } from "../../shared/workspaceFileVisualKind.ts";

export type AgentMentionFileVisualKind =
  | "back"
  | "document"
  | "code"
  | "markdown"
  | "image"
  | "video"
  | "folder";

export function resolveAgentMentionFileVisualKind(input: {
  entryKind?: string | null;
  href?: string | null;
  mentionNavigation?: string | null;
  name?: string | null;
  path?: string | null;
}): AgentMentionFileVisualKind {
  if (
    input.mentionNavigation === "agent-generated-folder-back" ||
    input.mentionNavigation === "workspace-folder-back"
  ) {
    return "back";
  }
  if (input.entryKind === "directory") {
    return "folder";
  }
  const pathOrName =
    input.path?.trim() || input.name?.trim() || input.href?.trim() || "";
  const kind = resolveAgentWorkspaceFileVisualKind(pathOrName, {
    refType: "file"
  });
  return kind === "binary" ? "document" : kind;
}

export function resolveAgentMentionFileThumbnailUrl(input: {
  entryKind?: string | null;
  href?: string | null;
  name?: string | null;
  path?: string | null;
  thumbnailUrl?: string | null;
}): string | undefined {
  if (resolveAgentMentionFileVisualKind(input) !== "image") {
    return undefined;
  }
  const thumbnailUrl = input.thumbnailUrl?.trim() ?? "";
  return thumbnailUrl || undefined;
}
