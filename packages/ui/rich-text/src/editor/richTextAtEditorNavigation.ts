import type { RichTextTriggerQueryMatch as RichTextAtQueryMatch } from "../types/trigger.ts";

export interface RichTextAtEditorNavigationMatchEntry {
  key: string;
  type: "match";
  match: RichTextAtQueryMatch;
}

export interface RichTextAtEditorNavigationActionEntry {
  key: string;
  type: "action";
  onSelect: () => void;
}

export type RichTextAtEditorNavigationEntry =
  | RichTextAtEditorNavigationMatchEntry
  | RichTextAtEditorNavigationActionEntry;

export function richTextAtEditorMatchEntryKey(
  match: RichTextAtQueryMatch
): string {
  return `${match.providerId}:${match.key}`;
}

export function createRichTextAtEditorMatchEntry(
  match: RichTextAtQueryMatch,
  key = richTextAtEditorMatchEntryKey(match)
): RichTextAtEditorNavigationMatchEntry {
  return {
    key,
    type: "match",
    match
  };
}

export function createRichTextAtEditorMatchEntries(
  matches: readonly RichTextAtQueryMatch[]
): RichTextAtEditorNavigationMatchEntry[] {
  return matches.map((match) => createRichTextAtEditorMatchEntry(match));
}

export function findRichTextAtEditorNavigationEntry(
  entries: readonly RichTextAtEditorNavigationEntry[],
  key: string | null
): RichTextAtEditorNavigationEntry | null {
  if (!key) {
    return null;
  }
  return entries.find((entry) => entry.key === key) ?? null;
}

export function findRichTextAtEditorEntryKeyForMatch(
  entries: readonly RichTextAtEditorNavigationEntry[],
  match: RichTextAtQueryMatch
): string {
  return (
    entries.find(
      (entry) =>
        entry.type === "match" &&
        isSameRichTextAtEditorMatch(entry.match, match)
    )?.key ?? richTextAtEditorMatchEntryKey(match)
  );
}

export function resolveRichTextAtEditorActiveEntryKey(input: {
  entries: readonly RichTextAtEditorNavigationEntry[];
  activeEntryKey: string | null;
}): string | null {
  if (input.entries.length === 0) {
    return null;
  }
  if (
    input.activeEntryKey &&
    input.entries.some((entry) => entry.key === input.activeEntryKey)
  ) {
    return input.activeEntryKey;
  }
  return input.entries[0]?.key ?? null;
}

export function moveRichTextAtEditorActiveEntryKey(input: {
  entries: readonly RichTextAtEditorNavigationEntry[];
  activeEntryKey: string | null;
  delta: 1 | -1;
}): string | null {
  if (input.entries.length === 0) {
    return null;
  }
  const currentIndex = input.activeEntryKey
    ? input.entries.findIndex((entry) => entry.key === input.activeEntryKey)
    : -1;
  const baseIndex = currentIndex >= 0 ? currentIndex : input.delta > 0 ? -1 : 0;
  return (
    input.entries[
      (baseIndex + input.delta + input.entries.length) % input.entries.length
    ]?.key ?? null
  );
}

export function haveSameRichTextAtEditorNavigationEntries(
  left: readonly RichTextAtEditorNavigationEntry[] | null,
  right: readonly RichTextAtEditorNavigationEntry[] | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const other = right[index];
    if (!other || entry.key !== other.key || entry.type !== other.type) {
      return false;
    }
    if (entry.type === "match" && other.type === "match") {
      return isSameRichTextAtEditorMatch(entry.match, other.match);
    }
    if (entry.type === "action" && other.type === "action") {
      return entry.onSelect === other.onSelect;
    }
    return false;
  });
}

export function isSameRichTextAtEditorMatch(
  left: RichTextAtQueryMatch,
  right: RichTextAtQueryMatch
): boolean {
  return left.providerId === right.providerId && left.key === right.key;
}
