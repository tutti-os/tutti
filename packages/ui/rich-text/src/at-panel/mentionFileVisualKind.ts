/**
 * Pure, dependency-free file visual-kind helpers shared by every `@`-mention
 * surface that renders a {@link MentionRow}. The *base* extension → kind
 * resolution lives in each surface (the agent maps file-manager kinds, etc.);
 * this module owns only the surface-agnostic vocabulary and the thumbnail rule
 * so the shared row renderer never imports a workspace feature.
 */
export type MentionFileVisualKind =
  | "back"
  | "document"
  | "code"
  | "markdown"
  | "image"
  | "video"
  | "folder";

export interface MentionFileVisualKindInput {
  entryKind?: string | null;
  mentionNavigation?: string | null;
  /**
   * The base visual kind already resolved from the file extension/name by the
   * surface (e.g. the agent's file-manager mapping). Used as the fallback when
   * the entry is neither a back-navigation marker nor a directory.
   */
  baseVisualKind: MentionFileVisualKind;
}

/**
 * Resolve the row's visual kind from a pre-resolved {@link MentionFileVisualKindInput.baseVisualKind}
 * plus the structural markers (back navigation, directory) that override it.
 */
export function resolveMentionFileVisualKind(
  input: MentionFileVisualKindInput
): MentionFileVisualKind {
  if (
    input.mentionNavigation === "agent-generated-folder-back" ||
    input.mentionNavigation === "workspace-folder-back"
  ) {
    return "back";
  }
  if (input.entryKind === "directory") {
    return "folder";
  }
  return input.baseVisualKind;
}

/**
 * The thumbnail is only shown for image entries with a non-empty thumbnail URL.
 */
export function resolveMentionFileThumbnailUrl(input: {
  visualKind: MentionFileVisualKind;
  thumbnailUrl?: string | null;
}): string | undefined {
  if (input.visualKind !== "image") {
    return undefined;
  }
  const thumbnailUrl = input.thumbnailUrl?.trim() ?? "";
  return thumbnailUrl || undefined;
}
