import type { ReactNode } from "react";

export type MentionPaletteFilterId = string;
export type MentionPaletteGroupId = string;

export interface MentionPaletteCategory {
  id: MentionPaletteFilterId;
  label: string;
}

export interface MentionPaletteGroup<TItem> {
  id: MentionPaletteGroupId;
  label?: string;
  items: readonly TItem[];
  totalCount: number;
  visibleCount: number;
  hasMore: boolean;
  emptyLabel?: string;
  /**
   * Optional precomputed label for the "show more" expand control. When omitted
   * the shell falls back to `+<remaining>`. Surfaces that need exact wording
   * (e.g. the agent's translated "show N more") compute this themselves so the
   * shell stays free of surface-specific i18n.
   */
  expandLabel?: string;
  /**
   * Optional extra class names applied to the group `<section>` element. Lets a
   * consumer add bespoke spacing between specific groups (e.g. extra top margin
   * when one group directly follows a related one) without the shell needing to
   * know about surface-specific group relationships.
   */
  sectionClassName?: string;
  /**
   * When true the shell omits the divider it would otherwise render above this
   * group (the divider normally appears before every group after the first).
   * Lets a consumer suppress inter-group chrome in specific contexts (e.g. while
   * showing a flat, ungrouped search result list).
   */
  hideTopDivider?: boolean;
}

/**
 * Generic theming hooks so a consumer can keep its own stylesheet class names,
 * test ids, and divider data-attribute when migrating onto the shared shell.
 * Every field is optional and defaults to the shell's own `rich-text-at-*`
 * identifiers, so the shell stays surface-agnostic.
 */
export interface MentionPaletteTheme {
  classNames?: {
    palette?: string;
    header?: string;
    footer?: string;
    tabs?: string;
    scrollRegion?: string;
    scrollbar?: string;
    scrollbarThumb?: string;
    hint?: string;
    hintItem?: string;
    hintButton?: string;
    hintSeparator?: string;
    shortcut?: string;
    shortcutArrow?: string;
    shortcutButton?: string;
    shortcutGroup?: string;
  };
  testIds?: {
    emptyState?: string;
    hint?: string;
    scrollbar?: string;
    loadingSpinner?: string;
  };
  /** data-attribute (without value) used to mark the inter-group divider. */
  groupDividerAttribute?: string;
}

export type MentionPaletteState<TItem> =
  | {
      status: "idle";
      query: string;
      mode: "browse";
      filter: MentionPaletteFilterId;
      categories: readonly MentionPaletteCategory[];
      groups: readonly MentionPaletteGroup<TItem>[];
      error: null;
    }
  | {
      status: "loading" | "ready";
      query: string;
      mode: "browse" | "results";
      filter: MentionPaletteFilterId;
      categories: readonly MentionPaletteCategory[];
      groups: readonly MentionPaletteGroup<TItem>[];
      error: null;
    }
  | {
      status: "error";
      query: string;
      mode: "browse" | "results";
      filter: MentionPaletteFilterId;
      categories: readonly MentionPaletteCategory[];
      groups: readonly MentionPaletteGroup<TItem>[];
      error: string;
    };

export interface MentionPaletteEntry {
  key: string;
  type: "category" | "item" | "expand";
  categoryId?: MentionPaletteFilterId;
  groupId?: MentionPaletteGroupId;
  itemIndex?: number;
}

export interface MentionPaletteProps<TItem> {
  state: MentionPaletteState<TItem>;
  highlightedKey: string | null;
  getItemKey: (item: TItem, group: MentionPaletteGroup<TItem>) => string;
  renderItem: (
    item: TItem,
    ctx: { active: boolean; group: MentionPaletteGroup<TItem> }
  ) => ReactNode;
  labels: {
    loading: string;
    empty: string;
    error: string;
    tabHint: string;
    /**
     * Accessible name for the listbox container. Defaults to `tabHint` when
     * omitted; consumers that label the whole palette differently from the
     * keyboard-hint bar supply it explicitly.
     */
    listbox?: string;
  };
  hintLabels: {
    cycleFilter: string;
    moveSelection: string;
    navigateHierarchy?: string;
  };
  maxHeightPx: number;
  onHighlightChange: (key: string) => void;
  onSelectItem: (item: TItem, group: MentionPaletteGroup<TItem>) => void;
  onSelectCategory: (categoryId: MentionPaletteFilterId) => void;
  onSelectFilter: (filter: MentionPaletteFilterId) => void;
  onExpandGroup: (groupId: MentionPaletteGroupId) => void;
  onCycleFilter: (delta: 1 | -1) => void;
  onMoveSelection: (delta: 1 | -1) => void;
  onNavigateHierarchy?: (delta: 1 | -1) => void;
  /** Rendered after the groups, before the keyboard hint bar. */
  renderListFooter?: () => ReactNode;
  /**
   * Rendered inside the header, directly under the category tabs, while results
   * are refreshing in-place (i.e. existing results stay visible). Consumers that
   * want an inline "refreshing" banner supply it here; omit for none.
   */
  loadingBanner?: ReactNode;
  /**
   * When true, scrolling the highlighted row into view centers it within the
   * scroll container instead of using the default `block: "nearest"` behavior.
   */
  scrollHighlightedIntoViewCentered?: boolean;
  /** Optional generic theming overrides; defaults to the shell's own styling. */
  theme?: MentionPaletteTheme;
}
