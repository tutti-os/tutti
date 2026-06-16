import type {
  RichTextAtInsertResult,
  RichTextAtQueryMatch
} from "../types/at.ts";

export type RichTextAtFilterId = string;
export type RichTextAtGroupId = string;

export interface RichTextAtFilterTab {
  id: RichTextAtFilterId;
  label: string;
}

export interface RichTextAtProviderGroup {
  id: RichTextAtGroupId;
  label: string;
  providerIds: readonly string[];
  filterId?: RichTextAtFilterId;
  emptyLabel?: string;
  pageSize?: number;
}

export interface RichTextAtPanelReferenceItem {
  key: string;
  label: string;
  subtitle?: string;
  thumbnailUrl?: string | null;
  insertResult: RichTextAtInsertResult;
}

export interface RichTextAtPanelMatch<
  TItem = unknown
> extends RichTextAtQueryMatch<TItem> {
  thumbnailUrl?: string | null;
  referenceItems?: readonly RichTextAtPanelReferenceItem[];
  referenceItemsLoading?: boolean;
  referenceNextCursor?: string | null;
}

export interface RichTextAtSearchGroup<TItem = unknown> {
  id: RichTextAtGroupId;
  label: string;
  items: readonly RichTextAtPanelMatch<TItem>[];
  totalCount: number;
  visibleCount: number;
  hasMore: boolean;
  emptyLabel?: string;
}
