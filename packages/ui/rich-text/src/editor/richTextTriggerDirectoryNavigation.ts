import type { RichTextTriggerQueryMatch } from "../types/trigger.ts";

export type RichTextTriggerDirectoryItemAction = "insert" | "enter" | "none";

export function resolveRichTextTriggerDirectoryItemAction(input: {
  interaction: "select" | "navigate";
  match: RichTextTriggerQueryMatch;
  providerId: string;
}): RichTextTriggerDirectoryItemAction {
  if (input.interaction === "select") {
    return "insert";
  }
  return input.match.providerId === input.providerId && input.match.directory
    ? "enter"
    : "none";
}

export function enterRichTextTriggerDirectory(
  paths: readonly string[],
  path: string
): readonly string[] {
  const canonicalPath = path.trim();
  return canonicalPath ? [...paths, canonicalPath] : paths;
}

export function exitRichTextTriggerDirectory(
  paths: readonly string[]
): readonly string[] {
  return paths.length === 0 ? paths : paths.slice(0, -1);
}
