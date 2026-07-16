import type {
  MentionPaletteCategory,
  MentionPaletteEntry,
  MentionPaletteGroup,
  MentionPaletteState
} from "./mentionPaletteTypes.ts";
import { flattenMentionPaletteEntries } from "./mentionPaletteEntries.ts";
import type { RichTextTriggerQueryMatch } from "../types/trigger.ts";

export interface MentionPaletteModelInput<TItem> {
  activeCategoryId: string;
  categories: readonly MentionPaletteCategory[];
  groups: readonly MentionPaletteGroup<TItem>[];
  loading: boolean;
  query?: string;
  mode?: "browse" | "results";
}

export interface MentionPaletteSectionConfig<
  TMatch extends RichTextTriggerQueryMatch = RichTextTriggerQueryMatch
> {
  id: string;
  label?: string;
  providerIds?: readonly string[];
  matches?: (match: TMatch) => boolean;
  emptyLabel?: string;
}

export interface MentionPaletteCategoryConfig<
  TMatch extends RichTextTriggerQueryMatch = RichTextTriggerQueryMatch
> {
  id: string;
  label: string;
  providerIds?: readonly string[];
  matches?: (match: TMatch) => boolean;
  emptyLabel?: string;
  sections?: readonly MentionPaletteSectionConfig<TMatch>[];
}

export function mentionPaletteGroup<TItem>(input: {
  id: string;
  label?: string;
  items: readonly TItem[];
  emptyLabel?: string;
}): MentionPaletteGroup<TItem> {
  return {
    id: input.id,
    label: input.label,
    items: input.items,
    totalCount: input.items.length,
    visibleCount: input.items.length,
    hasMore: false,
    emptyLabel: input.emptyLabel
  };
}

export function mentionPaletteExpandLabel<TItem>(
  group: Pick<
    MentionPaletteGroup<TItem>,
    | "expandErrorLabel"
    | "expandLabel"
    | "expandLoadingLabel"
    | "expandStatus"
    | "totalCount"
    | "visibleCount"
  >
): string {
  const fallbackLabel =
    group.expandLabel ??
    `+${Math.max(0, group.totalCount - group.visibleCount)}`;
  if (group.expandStatus === "loading") {
    return group.expandLoadingLabel ?? fallbackLabel;
  }
  if (group.expandStatus === "error") {
    return group.expandErrorLabel ?? fallbackLabel;
  }
  return fallbackLabel;
}

export function buildMentionPaletteModel<TItem>(
  input: MentionPaletteModelInput<TItem>
): MentionPaletteState<TItem> {
  return {
    status: input.loading ? "loading" : "ready",
    query: input.query ?? "",
    mode: input.mode ?? "results",
    filter: input.activeCategoryId,
    categories: input.categories,
    groups: input.groups,
    error: null
  };
}

export function buildMentionPaletteModelFromTriggerMatches<
  TMatch extends RichTextTriggerQueryMatch = RichTextTriggerQueryMatch
>(input: {
  activeCategoryId: string;
  categories: readonly MentionPaletteCategoryConfig<TMatch>[];
  matches: readonly TMatch[];
  loading: boolean;
  query?: string;
  mode?: "browse" | "results";
}): MentionPaletteState<TMatch> {
  const categories = input.categories.map((category) => ({
    id: category.id,
    label: category.label
  }));
  const activeCategory =
    input.categories.find(
      (category) => category.id === input.activeCategoryId
    ) ??
    input.categories[0] ??
    null;
  const groups =
    activeCategory === null
      ? []
      : buildMentionPaletteGroupsForCategory(activeCategory, input.matches);

  return buildMentionPaletteModel({
    activeCategoryId: activeCategory?.id ?? input.activeCategoryId,
    categories,
    groups,
    loading: input.loading,
    query: input.query,
    mode: input.mode
  });
}

function buildMentionPaletteGroupsForCategory<
  TMatch extends RichTextTriggerQueryMatch
>(
  category: MentionPaletteCategoryConfig<TMatch>,
  matches: readonly TMatch[]
): MentionPaletteGroup<TMatch>[] {
  const categoryMatches = matches.filter((match) =>
    mentionPaletteConfigMatches(category, match)
  );
  if (!category.sections?.length) {
    if (categoryMatches.length === 0 && category.emptyLabel == null) {
      return [];
    }
    return [
      mentionPaletteGroup({
        id: category.id,
        items: categoryMatches,
        emptyLabel: category.emptyLabel
      })
    ];
  }

  const sectionItems = new Map<string, TMatch[]>(
    category.sections.map((section) => [section.id, []])
  );
  for (const match of categoryMatches) {
    const section = category.sections.find((candidate) =>
      mentionPaletteConfigMatches(candidate, match)
    );
    if (!section) {
      continue;
    }
    sectionItems.get(section.id)?.push(match);
  }

  return category.sections
    .map((section) => {
      const items = sectionItems.get(section.id) ?? [];
      if (items.length === 0 && section.emptyLabel == null) {
        return null;
      }
      return mentionPaletteGroup({
        id: section.id,
        label: section.label,
        items,
        emptyLabel: section.emptyLabel
      });
    })
    .filter((group): group is MentionPaletteGroup<TMatch> => group !== null);
}

function mentionPaletteConfigMatches<TMatch extends RichTextTriggerQueryMatch>(
  config: {
    providerIds?: readonly string[];
    matches?: (match: TMatch) => boolean;
  },
  match: TMatch
): boolean {
  if (
    config.providerIds != null &&
    !config.providerIds.includes(match.providerId)
  ) {
    return false;
  }
  return config.matches?.(match) ?? true;
}

export function moveMentionPaletteHighlight<TItem>(input: {
  state: MentionPaletteState<TItem>;
  currentKey: string | null;
  delta: 1 | -1;
  getItemKey: (item: TItem, groupId: string) => string;
}): string | null {
  const entries = flattenMentionPaletteEntries(
    input.state,
    input.getItemKey
  ).filter(
    (entry) =>
      entry.type === "category" ||
      entry.type === "item" ||
      entry.type === "expand"
  );
  if (!entries.length) {
    return null;
  }
  const foundIndex = entries.findIndex(
    (entry) => entry.key === input.currentKey
  );
  const currentIndex = foundIndex >= 0 ? foundIndex : input.delta > 0 ? -1 : 0;
  return (
    entries[(currentIndex + input.delta + entries.length) % entries.length]
      ?.key ?? null
  );
}

export function repairMentionPaletteHighlight<TItem>(input: {
  state: MentionPaletteState<TItem>;
  currentKey: string | null;
  getItemKey: (item: TItem, groupId: string) => string;
  preferredKey?: string | null;
}): string | null {
  const entries = flattenMentionPaletteEntries(input.state, input.getItemKey);
  if (entries.length === 0) {
    return null;
  }
  if (
    input.currentKey !== null &&
    entries.some((entry) => entry.key === input.currentKey)
  ) {
    return input.currentKey;
  }
  if (
    input.preferredKey != null &&
    entries.some((entry) => entry.key === input.preferredKey)
  ) {
    return input.preferredKey;
  }
  return entries[0]?.key ?? null;
}

export function findMentionPaletteEntry<TItem>(input: {
  state: MentionPaletteState<TItem>;
  key: string | null;
  getItemKey: (item: TItem, groupId: string) => string;
}): MentionPaletteEntry | null {
  if (input.key === null) {
    return null;
  }
  return (
    flattenMentionPaletteEntries(input.state, input.getItemKey).find(
      (entry) => entry.key === input.key
    ) ?? null
  );
}

export function selectedMentionPaletteItem<TItem>(input: {
  state: MentionPaletteState<TItem>;
  key: string | null;
  getItemKey: (item: TItem, groupId: string) => string;
}): TItem | null {
  for (const group of input.state.groups) {
    const index = group.items.findIndex(
      (candidate) =>
        `${group.id}:${input.getItemKey(candidate, group.id)}` === input.key
    );
    if (index >= 0) {
      return group.items[index] ?? null;
    }
  }
  return null;
}

export function nextMentionPaletteCategory<TCategoryId extends string>(
  categories: readonly { id: TCategoryId }[],
  current: TCategoryId,
  delta: 1 | -1
): TCategoryId {
  const index = categories.findIndex((category) => category.id === current);
  const safeIndex = index >= 0 ? index : 0;
  return categories[
    (safeIndex + delta + categories.length) % categories.length
  ]!.id;
}
