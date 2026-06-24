import {
  tuttiExternalAtProviderIds,
  type TuttiExternalAtProviderId,
  type TuttiExternalAtQueryInput,
  type TuttiExternalAtQueryResult
} from "../contracts/index.ts";
import type {
  RichTextTriggerInsertResult,
  RichTextTriggerProvider
} from "@tutti-os/ui-rich-text/types";

export interface TuttiExternalAtRichTextBridge {
  at?: {
    query(
      input: TuttiExternalAtQueryInput
    ):
      | Promise<readonly TuttiExternalAtQueryResult[]>
      | readonly TuttiExternalAtQueryResult[];
  };
}

export interface CreateTuttiExternalAtRichTextTriggerProviderInput {
  bridge: TuttiExternalAtRichTextBridge | null | undefined;
  providerId: TuttiExternalAtProviderId;
  maxResults?: number;
}

export interface CreateTuttiExternalAtRichTextTriggerProvidersInput {
  bridge: TuttiExternalAtRichTextBridge | null | undefined;
  providerIds?: readonly TuttiExternalAtProviderId[];
  maxResults?: number;
}

export interface QueryTuttiExternalAtRichTextTriggerItemsInput {
  bridge: TuttiExternalAtRichTextBridge | null | undefined;
  keyword: string;
  providerIds?: readonly TuttiExternalAtProviderId[];
  maxResults?: number;
}

export async function queryTuttiExternalAtRichTextTriggerItems(
  input: QueryTuttiExternalAtRichTextTriggerItemsInput
): Promise<readonly TuttiExternalAtQueryResult[]> {
  const bridge = input.bridge?.at;
  if (!bridge) return [];

  const providerIds =
    input.providerIds === undefined
      ? tuttiExternalAtProviderIds
      : input.providerIds;
  const results = await bridge.query({
    keyword: input.keyword,
    ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
    providers: providerIds
  });
  const providerSet = new Set<TuttiExternalAtProviderId>(providerIds);
  return results.filter((item) => providerSet.has(item.providerId));
}

export function createTuttiExternalAtRichTextTriggerProvider(
  input: CreateTuttiExternalAtRichTextTriggerProviderInput
): RichTextTriggerProvider<TuttiExternalAtQueryResult> {
  return {
    id: input.providerId,
    trigger: "@",
    async query(queryInput) {
      return queryTuttiExternalAtRichTextTriggerItems({
        bridge: input.bridge,
        keyword: queryInput.keyword,
        maxResults: queryInput.maxResults ?? input.maxResults,
        providerIds: [input.providerId]
      });
    },
    getItemKey: (item) => item.itemId,
    getItemLabel: (item) => item.label,
    getItemSubtitle: (item) => item.subtitle,
    getItemIconUrl: (item) =>
      item.thumbnailUrl ??
      (item.insert.kind === "mention"
        ? (item.insert.mention.presentation?.iconUrl ??
          item.insert.mention.presentation?.thumbnailUrl ??
          item.insert.mention.presentation?.agentIconUrl)
        : undefined),
    toInsertResult: (item) => item.insert as RichTextTriggerInsertResult
  };
}

export function createTuttiExternalAtRichTextTriggerProviders(
  input: CreateTuttiExternalAtRichTextTriggerProvidersInput
): readonly RichTextTriggerProvider<TuttiExternalAtQueryResult>[] {
  const providerIds =
    input.providerIds === undefined
      ? tuttiExternalAtProviderIds
      : input.providerIds;
  return providerIds.map((providerId) =>
    createTuttiExternalAtRichTextTriggerProvider({
      bridge: input.bridge,
      providerId,
      maxResults: input.maxResults
    })
  );
}
