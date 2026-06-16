import type {
  MentionPaletteEntry,
  MentionPaletteState
} from "./mentionPaletteTypes.ts";

/**
 * Returns true when at least one group has items or a "load more" trigger,
 * i.e. there is something interactive to render beyond category headers.
 */
function hasInteractiveGroupEntries<TItem>(
  groups: MentionPaletteState<TItem>["groups"]
): boolean {
  return groups.some((group) => group.items.length > 0 || group.hasMore);
}

/**
 * Flatten the palette state into a stable, ordered list of navigable entries.
 *
 * Mirrors the ordering and key format of `flattenAgentMentionPaletteEntries`
 * from AgentFileMentionPalette.tsx, but is generic over item type.
 *
 * Key formats:
 *   category entry  →  `category:<categoryId>`
 *   item entry      →  `<groupId>:<getItemKey(item, groupId)>`
 *   expand entry    →  `expand:<groupId>`
 */
export function flattenMentionPaletteEntries<TItem>(
  state: MentionPaletteState<TItem>,
  getItemKey: (item: TItem, groupId: string) => string
): MentionPaletteEntry[] {
  // Browse mode with no interactive group content → show category nav only
  if (state.mode === "browse" && !hasInteractiveGroupEntries(state.groups)) {
    return state.categories.map((category) => ({
      key: `category:${category.id}`,
      type: "category" as const,
      categoryId: category.id
    }));
  }

  const entries: MentionPaletteEntry[] = [];

  for (const group of state.groups) {
    group.items.forEach((item, index) => {
      entries.push({
        key: `${group.id}:${getItemKey(item, group.id)}`,
        type: "item",
        groupId: group.id,
        itemIndex: index
      });
    });

    if (group.hasMore) {
      entries.push({
        key: `expand:${group.id}`,
        type: "expand",
        groupId: group.id
      });
    }
  }

  return entries;
}
