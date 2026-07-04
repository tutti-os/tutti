import type { JSX, ReactNode } from "react";
import { MentionPalette } from "./MentionPalette.tsx";
import {
  createMentionPaletteStateAdapter,
  type MentionPaletteStateAdapterInput
} from "./mentionPaletteStateAdapter.ts";
import type {
  MentionPaletteGroup,
  MentionPaletteProps,
  MentionPaletteTheme
} from "./mentionPaletteTypes.ts";

export interface MentionPaletteFromStateProps<
  TItem
> extends MentionPaletteStateAdapterInput<TItem> {
  labels: MentionPaletteProps<TItem>["labels"];
  hintLabels: MentionPaletteProps<TItem>["hintLabels"];
  maxHeightPx: number;
  renderItem: (
    item: TItem,
    ctx: { active: boolean; group: MentionPaletteGroup<TItem> }
  ) => ReactNode;
  renderListFooter?: () => ReactNode;
  loadingBanner?: ReactNode;
  scrollHighlightedIntoViewCentered?: boolean;
  theme?: MentionPaletteTheme;
  onNavigateHierarchy?: MentionPaletteProps<TItem>["onNavigateHierarchy"];
}

export function MentionPaletteFromState<TItem>(
  props: MentionPaletteFromStateProps<TItem>
): JSX.Element {
  "use memo";
  const {
    labels,
    hintLabels,
    maxHeightPx,
    renderItem,
    renderListFooter,
    loadingBanner,
    scrollHighlightedIntoViewCentered,
    theme,
    onNavigateHierarchy,
    ...adapterInput
  } = props;
  const adapter = createMentionPaletteStateAdapter(adapterInput);

  return (
    <MentionPalette
      {...adapter.paletteProps}
      labels={labels}
      hintLabels={hintLabels}
      maxHeightPx={maxHeightPx}
      renderItem={renderItem}
      renderListFooter={renderListFooter}
      loadingBanner={loadingBanner}
      scrollHighlightedIntoViewCentered={scrollHighlightedIntoViewCentered}
      theme={theme}
      onNavigateHierarchy={onNavigateHierarchy}
    />
  );
}
