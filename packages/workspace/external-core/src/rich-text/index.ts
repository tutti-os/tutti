import {
  tuttiExternalAtProviderIds,
  type TuttiExternalAtInvalidation,
  type TuttiExternalAtProviderId,
  type TuttiExternalAtQueryInput,
  type TuttiExternalAtQueryResult,
  type TuttiExternalAtResolveInput,
  type TuttiExternalAtResolveResult
} from "../contracts/index.ts";
import type {
  RichTextMentionIdentity,
  RichTextTriggerInsertResult,
  RichTextTriggerProvider
} from "@tutti-os/ui-rich-text/types";
import {
  createRichTextMentionService,
  canonicalizeRichTextMentionScope,
  type RichTextMentionService
} from "@tutti-os/ui-rich-text/service";

export interface TuttiExternalAtRichTextBridge {
  at?: {
    query(
      input: TuttiExternalAtQueryInput
    ):
      | Promise<readonly TuttiExternalAtQueryResult[]>
      | readonly TuttiExternalAtQueryResult[];
    resolve?(
      input: TuttiExternalAtResolveInput
    ):
      | Promise<TuttiExternalAtResolveResult | null>
      | TuttiExternalAtResolveResult
      | null;
    subscribe?(
      listener: (event: TuttiExternalAtInvalidation) => void
    ): () => void;
  };
}

export interface CreateTuttiExternalAtRichTextTriggerProviderInput {
  bridge?: TuttiExternalAtRichTextBridge | null;
  getBridge?: () => TuttiExternalAtRichTextBridge | null | undefined;
  providerId: TuttiExternalAtProviderId;
  maxResults?: number;
}

export interface CreateTuttiExternalAtRichTextTriggerProvidersInput {
  bridge?: TuttiExternalAtRichTextBridge | null;
  getBridge?: () => TuttiExternalAtRichTextBridge | null | undefined;
  providerIds?: readonly TuttiExternalAtProviderId[];
  maxResults?: number;
}

export interface QueryTuttiExternalAtRichTextTriggerItemsInput {
  bridge?: TuttiExternalAtRichTextBridge | null;
  getBridge?: () => TuttiExternalAtRichTextBridge | null | undefined;
  keyword: string;
  providerIds?: readonly TuttiExternalAtProviderId[];
  maxResults?: number;
}

export interface CreateTuttiExternalRichTextMentionServiceInput {
  getBridge: () => TuttiExternalAtRichTextBridge | null | undefined;
  providerIds?: readonly TuttiExternalAtProviderId[];
  appLocalProviders?: readonly RichTextTriggerProvider[];
  maxResults?: number;
}

export async function queryTuttiExternalAtRichTextTriggerItems(
  input: QueryTuttiExternalAtRichTextTriggerItemsInput
): Promise<readonly TuttiExternalAtQueryResult[]> {
  const bridge = (input.getBridge?.() ?? input.bridge)?.at;
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
        getBridge: input.getBridge,
        keyword: queryInput.keyword,
        maxResults: queryInput.maxResults ?? input.maxResults,
        providerIds: [input.providerId]
      });
    },
    async resolveMention(identity) {
      const bridge = (input.getBridge?.() ?? input.bridge)?.at;
      if (!bridge) return null;
      if (bridge.resolve) {
        return bridge.resolve({
          providerId: input.providerId,
          entityId: identity.entityId,
          ...(identity.scope ? { scope: identity.scope } : {})
        });
      }
      const fallbackKeywords = [
        identity.label.trim().replace(/^@+/, "").trim(),
        ""
      ].filter((keyword, index, values) => values.indexOf(keyword) === index);
      for (const keyword of fallbackKeywords) {
        const matches = await queryTuttiExternalAtRichTextTriggerItems({
          bridge: input.bridge,
          getBridge: input.getBridge,
          keyword,
          maxResults: 50,
          providerIds: [input.providerId]
        });
        const match = matches.find((item) =>
          matchesExternalMentionIdentity(item, identity)
        );
        if (match?.insert.kind === "mention") {
          return {
            label: match.insert.mention.label,
            presentation: match.insert.mention.presentation
          };
        }
      }
      return null;
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
      getBridge: input.getBridge,
      providerId,
      maxResults: input.maxResults
    })
  );
}

export function createTuttiExternalRichTextMentionService(
  input: CreateTuttiExternalRichTextMentionServiceInput
): RichTextMentionService {
  const hostProviders = createTuttiExternalAtRichTextTriggerProviders({
    getBridge: input.getBridge,
    providerIds: input.providerIds,
    maxResults: input.maxResults
  });
  const service = createRichTextMentionService({
    providers: [...hostProviders, ...(input.appLocalProviders ?? [])]
  });
  const unsubscribe = input.getBridge()?.at?.subscribe?.((event) => {
    invalidateFromExternalEvent(service, event);
  });
  const disposeService = service.dispose.bind(service);
  let disposed = false;
  service.dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    disposeService();
  };
  return service;
}

function matchesExternalMentionIdentity(
  item: TuttiExternalAtQueryResult,
  identity: RichTextMentionIdentity
): boolean {
  if (
    item.providerId !== identity.providerId ||
    item.insert.kind !== "mention"
  ) {
    return false;
  }
  return (
    item.insert.mention.entityId.trim() === identity.entityId.trim() &&
    canonicalizeRichTextMentionScope(item.insert.mention.scope) ===
      canonicalizeRichTextMentionScope(identity.scope)
  );
}

function invalidateFromExternalEvent(
  service: RichTextMentionService,
  event: TuttiExternalAtInvalidation
): void {
  const providerIds = event.providerIds?.length
    ? event.providerIds
    : [undefined];
  const entityIds = event.entityIds?.length ? event.entityIds : [undefined];
  for (const providerId of providerIds) {
    for (const entityId of entityIds) {
      service.invalidate({ providerId, entityId });
    }
  }
}
