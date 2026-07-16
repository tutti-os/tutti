import type {
  RichTextMentionIdentity,
  RichTextMentionInsert,
  RichTextMentionResolved
} from "./mention.ts";

export type RichTextTrigger = "@" | "/" | "$";
export type RichTextTriggerBoundary = "punctuation" | "whitespace";

export interface RichTextTriggerConfig {
  trigger: RichTextTrigger;
  boundary: RichTextTriggerBoundary;
}

export interface RichTextTriggerProviderContext {
  locale?: string;
  documentText?: string;
  blockText?: string;
  selectionText?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface RichTextTriggerQueryInput {
  keyword: string;
  maxResults?: number;
  abortSignal?: AbortSignal;
  context: RichTextTriggerProviderContext;
  trigger: RichTextTrigger;
}

export interface RichTextTriggerQueryGroup<TItem = unknown> {
  /** Stable provider-owned identity used only by candidate-panel state. */
  id: string;
  label: string;
  items: readonly TItem[];
  totalCount: number;
  nextCursor?: string;
}

export interface RichTextTriggerGroupedQueryResult<TItem = unknown> {
  groups: readonly RichTextTriggerQueryGroup<TItem>[];
}

export interface RichTextTriggerGroupPageQueryInput extends RichTextTriggerQueryInput {
  groupId: string;
  cursor: string;
  pageSize: number;
}

export interface RichTextMentionTriggerInsertResult {
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

export type RichTextTriggerInsertResult =
  | RichTextMentionTriggerInsertResult
  | RichTextMarkdownLinkInsertResult
  | RichTextTextInsertResult;

export interface RichTextTriggerProvider<TItem = unknown> {
  id: string;
  trigger: RichTextTrigger;
  boundary?: RichTextTriggerBoundary;
  query(
    input: RichTextTriggerQueryInput
  ): Promise<readonly TItem[]> | readonly TItem[];
  /** Optional grouped/cursor query used by candidate panels that support it. */
  queryGroups?(
    input: RichTextTriggerQueryInput
  ):
    | Promise<RichTextTriggerGroupedQueryResult<TItem>>
    | RichTextTriggerGroupedQueryResult<TItem>;
  /** Load one page for one group without re-querying sibling groups. */
  queryGroupPage?(
    input: RichTextTriggerGroupPageQueryInput
  ):
    | Promise<RichTextTriggerQueryGroup<TItem>>
    | RichTextTriggerQueryGroup<TItem>;
  getItemKey(item: TItem): string;
  getItemLabel(item: TItem): string;
  getItemSubtitle?(item: TItem): string | null | undefined;
  getItemIconUrl?(
    item: TItem
  ): string | null | undefined | Promise<string | null | undefined>;
  getItemKeywords?(item: TItem): readonly string[] | undefined;
  toInsertResult(item: TItem): RichTextTriggerInsertResult;
  resolveMention?(
    identity: RichTextMentionIdentity
  ): Promise<RichTextMentionResolved | null> | RichTextMentionResolved | null;
}

export interface RichTextTriggerQueryMatch<TItem = unknown> {
  providerId: string;
  trigger: RichTextTrigger;
  key: string;
  label: string;
  subtitle?: string;
  iconUrl?: string;
  keywords?: readonly string[];
  item: TItem;
  insertResult: RichTextTriggerInsertResult;
}

export interface RichTextTriggerRegistry {
  listProviders: () => readonly RichTextTriggerProvider[];
  getProvider: (providerId: string) => RichTextTriggerProvider | undefined;
  listTriggerConfigs: () => readonly RichTextTriggerConfig[];
  query: (
    input: RichTextTriggerQueryInput
  ) => Promise<readonly RichTextTriggerQueryMatch[]>;
}
