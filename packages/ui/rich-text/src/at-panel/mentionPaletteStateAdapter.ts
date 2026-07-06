import type {
  MentionPaletteGroup,
  MentionPaletteProps,
  MentionPaletteState
} from "./mentionPaletteTypes.ts";
import {
  findMentionPaletteEntry,
  moveMentionPaletteHighlight,
  nextMentionPaletteCategory,
  selectedMentionPaletteItem
} from "./mentionPaletteModel.ts";

type MentionPaletteCycleCategory =
  | string
  | {
      id: string;
    };

export interface MentionPaletteStateCallbacks<TItem> {
  onHighlightChange?: (key: string) => void;
  onActiveCategoryIdChange?: (categoryId: string) => void;
  onSelectItem?: (item: TItem) => void;
  onExpandGroup?: (groupId: string) => void;
}

export interface MentionPaletteStateAdapterInput<TItem> {
  state: MentionPaletteState<TItem>;
  highlightedKey: string | null;
  /**
   * Optional order used by Tab/Shift+Tab. Defaults to the rendered category
   * order; callers with a surface-specific results-mode tab order can pass it
   * here and keep that policy outside the shell.
   */
  categoryCycleOrder?: readonly MentionPaletteCycleCategory[];
  getItemKey: (item: TItem, groupId: string) => string;
  callbacks?: MentionPaletteStateCallbacks<TItem>;
}

export type MentionPaletteStateCommitResult<TItem> =
  | { type: "none" }
  | { type: "category"; categoryId: string }
  | { type: "expand"; groupId: string }
  | { type: "item"; item: TItem };

export interface MentionPaletteStateAdapter<TItem> {
  selectedItem: TItem | null;
  paletteProps: Pick<
    MentionPaletteProps<TItem>,
    | "state"
    | "highlightedKey"
    | "getItemKey"
    | "onHighlightChange"
    | "onSelectItem"
    | "onSelectCategory"
    | "onSelectFilter"
    | "onExpandGroup"
    | "onCycleFilter"
    | "onMoveSelection"
  >;
  moveSelection: (delta: 1 | -1) => string | null;
  selectCategory: (categoryId: string) => void;
  expandGroup: (groupId: string) => void;
  cycleCategory: (delta: 1 | -1) => string | null;
  commitHighlighted: () => MentionPaletteStateCommitResult<TItem>;
}

export function createMentionPaletteStateAdapter<TItem>(
  input: MentionPaletteStateAdapterInput<TItem>
): MentionPaletteStateAdapter<TItem> {
  const getPaletteItemKey = (
    item: TItem,
    group: MentionPaletteGroup<TItem>
  ): string => input.getItemKey(item, group.id);

  const selectCategory = (categoryId: string): void => {
    input.callbacks?.onActiveCategoryIdChange?.(categoryId);
  };

  const expandGroup = (groupId: string): void => {
    input.callbacks?.onExpandGroup?.(groupId);
  };

  const moveSelection = (delta: 1 | -1): string | null => {
    const nextKey = moveMentionPaletteHighlight({
      state: input.state,
      currentKey: input.highlightedKey,
      delta,
      getItemKey: input.getItemKey
    });
    if (nextKey !== null) {
      input.callbacks?.onHighlightChange?.(nextKey);
    }
    return nextKey;
  };

  const cycleCategory = (delta: 1 | -1): string | null => {
    const cycleCategories = resolveCycleCategories(input.categoryCycleOrder);
    const categories = cycleCategories.length
      ? cycleCategories
      : input.state.categories;
    if (categories.length === 0) {
      return null;
    }
    const nextCategoryId = nextMentionPaletteCategory(
      categories,
      input.state.filter,
      delta
    );
    selectCategory(nextCategoryId);
    return nextCategoryId;
  };

  const selectedItem = selectedMentionPaletteItem({
    state: input.state,
    key: input.highlightedKey,
    getItemKey: input.getItemKey
  });

  const commitHighlighted = (): MentionPaletteStateCommitResult<TItem> => {
    const activeEntry = findMentionPaletteEntry({
      state: input.state,
      key: input.highlightedKey,
      getItemKey: input.getItemKey
    });
    const fallbackCategoryId = categoryIdFromKey(input.highlightedKey);

    if (!activeEntry) {
      // A highlighted key that decodes to the *already-active* filter is not
      // a pending "drill into this category" action — it means the active
      // category resolved to having nothing flatten-able (e.g. a
      // structurally empty category like "No tasks yet", not a query that
      // filtered a category down to zero). Re-selecting the same category
      // would be a no-op that silently swallows Enter forever, so treat it
      // the same as a zero-result search: nothing to commit.
      if (
        fallbackCategoryId !== null &&
        fallbackCategoryId !== input.state.filter &&
        input.state.categories.some(
          (category) => category.id === fallbackCategoryId
        )
      ) {
        selectCategory(fallbackCategoryId);
        return { type: "category", categoryId: fallbackCategoryId };
      }
      return { type: "none" };
    }

    if (activeEntry.type === "category" && activeEntry.categoryId) {
      selectCategory(activeEntry.categoryId);
      return { type: "category", categoryId: activeEntry.categoryId };
    }

    if (activeEntry.type === "expand" && activeEntry.groupId) {
      expandGroup(activeEntry.groupId);
      return { type: "expand", groupId: activeEntry.groupId };
    }

    if (activeEntry.type === "item") {
      const item = selectedMentionPaletteItem({
        state: input.state,
        key: activeEntry.key,
        getItemKey: input.getItemKey
      });
      if (item !== null) {
        input.callbacks?.onSelectItem?.(item);
        return { type: "item", item };
      }
    }

    return { type: "none" };
  };

  return {
    selectedItem,
    paletteProps: {
      state: input.state,
      highlightedKey: input.highlightedKey,
      getItemKey: getPaletteItemKey,
      onHighlightChange: (key) => {
        input.callbacks?.onHighlightChange?.(key);
      },
      onSelectItem: (item) => {
        input.callbacks?.onSelectItem?.(item);
      },
      onSelectCategory: selectCategory,
      onSelectFilter: selectCategory,
      onExpandGroup: expandGroup,
      onCycleFilter: cycleCategory,
      onMoveSelection: moveSelection
    },
    moveSelection,
    selectCategory,
    expandGroup,
    cycleCategory,
    commitHighlighted
  };
}

function resolveCycleCategories(
  categories: readonly MentionPaletteCycleCategory[] | undefined
): readonly { id: string }[] {
  return (
    categories?.map((category) =>
      typeof category === "string" ? { id: category } : category
    ) ?? []
  );
}

function categoryIdFromKey(key: string | null): string | null {
  const prefix = "category:";
  return key?.startsWith(prefix) ? key.slice(prefix.length) : null;
}
