import type {
  RichTextTriggerInsertResult,
  RichTextTriggerQueryMatch as RichTextAtQueryMatch
} from "../types/trigger.ts";

export type RichTextAtFilterId = string;
export type RichTextAtGroupId = string;

export interface RichTextAtFilterTab {
  id: RichTextAtFilterId;
  label: string;
}

export interface RichTextTriggerProviderGroup {
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
  insertResult: RichTextTriggerInsertResult;
}

export interface RichTextAtPanelMatch<
  TItem = unknown
> extends RichTextAtQueryMatch<TItem> {
  thumbnailUrl?: string;
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
