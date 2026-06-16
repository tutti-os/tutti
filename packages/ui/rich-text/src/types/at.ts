import type { RichTextMentionInsert } from "./mention.ts";

export type RichTextAtTrigger = "@";

export interface RichTextAtProviderContext {
  locale?: string;
  documentText?: string;
  blockText?: string;
  selectionText?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface RichTextAtQueryInput {
  keyword: string;
  maxResults?: number;
  cursor?: string;
  abortSignal?: AbortSignal;
  context: RichTextAtProviderContext;
}

export interface RichTextMentionAtInsertResult {
  kind: "mention";
  mention: RichTextMentionInsert;
}

export interface RichTextMarkdownLinkInsertResult {
  kind: "markdown-link";
  label: string;
  href: string;
}

export interface RichTextTextInsertResult {
  kind: "text";
  text: string;
}

export type RichTextAtInsertResult =
  | RichTextMentionAtInsertResult
  | RichTextMarkdownLinkInsertResult
  | RichTextTextInsertResult;

export interface RichTextAtReferenceItem {
  key?: string;
  label: string;
  subtitle?: string | null;
  thumbnailUrl?: string | null;
  insertResult: RichTextAtInsertResult;
}

export interface RichTextAtReferenceItemsResult {
  items: readonly RichTextAtReferenceItem[];
  nextCursor?: string | null;
}

export type RichTextAtReferenceItemsResponse =
  | readonly RichTextAtReferenceItem[]
  | RichTextAtReferenceItemsResult;

export interface RichTextAtProvider<TItem = unknown> {
  id: string;
  trigger?: RichTextAtTrigger;
  query: (
    input: RichTextAtQueryInput
  ) => Promise<readonly TItem[]> | readonly TItem[];
  getItemKey: (item: TItem) => string;
  getItemLabel: (item: TItem) => string;
  getItemSubtitle?: (item: TItem) => string | null | undefined;
  getItemKeywords?: (item: TItem) => readonly string[] | undefined;
  getItemThumbnailUrl?: (
    item: TItem
  ) => string | null | undefined | Promise<string | null | undefined>;
  getItemReferenceItems?: (
    item: TItem,
    input: RichTextAtQueryInput
  ) =>
    | Promise<RichTextAtReferenceItemsResponse>
    | RichTextAtReferenceItemsResponse;
  toInsertResult: (item: TItem) => RichTextAtInsertResult;
}

export interface RichTextAtQueryMatch<TItem = unknown> {
  providerId: string;
  key: string;
  label: string;
  subtitle?: string;
  keywords?: readonly string[];
  item: TItem;
  insertResult: RichTextAtInsertResult;
}

export interface RichTextAtRegistry {
  listProviders: () => readonly RichTextAtProvider[];
  getProvider: (providerId: string) => RichTextAtProvider | undefined;
  query: (
    input: RichTextAtQueryInput
  ) => Promise<readonly RichTextAtQueryMatch[]>;
}
