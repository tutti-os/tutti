import type {
  MentionPaletteEntry,
  MentionPaletteState
} from "./mentionPaletteTypes.ts";

/**
 * Returns true when the group list reflects a *resolved* answer for the
 * active category — either because a group has interactive content, or
 * because a group is present with an explicit `emptyLabel` (i.e. "we looked,
 * there is nothing here", as opposed to "we haven't looked yet"). Groups
 * with no items, no `hasMore`, and no `emptyLabel` are placeholders for
 * content that hasn't loaded, not a genuinely empty category.
 */
function hasResolvedGroupData<TItem>(
  groups: MentionPaletteState<TItem>["groups"]
): boolean {
  return groups.some(
    (group) =>
      group.items.length > 0 || group.hasMore || group.emptyLabel != null
  );
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
  // Browse mode with no resolved group content → show category nav only.
  // This only applies while the active category truly has no answer yet
  // (e.g. still loading). A category that has resolved to "structurally
  // empty" (a group carrying an `emptyLabel`, like "No tasks yet") falls
  // through to the loop below, which naturally yields zero entries —
  // signalling callers (e.g. the composer's Enter handler) that there is
  // nothing to select, rather than re-surfacing the already-active category
  // as though it still needed picking.
  if (state.mode === "browse" && !hasResolvedGroupData(state.groups)) {
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
