import {
  tuttiExternalAtProviderIds,
  type TuttiExternalAtInvalidation,
  type TuttiExternalAtQueryDirectoryInput,
  type TuttiExternalAtProviderId,
  type TuttiExternalAtQueryInput,
  type TuttiExternalAtQueryResult,
  type TuttiExternalReferenceSelection,
  type TuttiExternalAtResolveInput,
  type TuttiExternalAtResolveResult
} from "../contracts/index.ts";
import type {
  RichTextMentionIdentity,
  RichTextTriggerInsertResult,
  RichTextTriggerProvider
} from "@tutti-os/ui-rich-text/types";
import {
  appendRichTextLinksToContent,
  createRichTextMentionMarkdown,
  extractRichTextMentionsFromContent,
  normalizeRichTextContent
} from "@tutti-os/ui-rich-text/core";
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
    queryDirectory?(
      input: TuttiExternalAtQueryDirectoryInput
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

function workspaceReferenceIdentityKey(input: {
  entityId: string;
  providerId: string;
  scope?: Readonly<Record<string, string>>;
}): string | null {
  if (input.providerId !== "workspace-reference") {
    return null;
  }
  const entityId = input.entityId.trim();
  const source = input.scope?.source?.trim() ?? "";
  const workspaceId = input.scope?.workspaceId?.trim() ?? "";
  if (!entityId || source !== "app" || !workspaceId) {
    return null;
  }
  return JSON.stringify([
    entityId,
    source,
    workspaceId,
    input.scope?.groupId?.trim() ?? ""
  ]);
}

/**
 * Appends Host-selected paths and lazy workspace-reference handles to the
 * serialized rich-text prompt. Selection order is stable within each kind,
 * duplicate paths or handles are omitted, and existing prompt text is kept.
 */
export function appendTuttiExternalReferenceSelections(
  value: string | null | undefined,
  selections: readonly TuttiExternalReferenceSelection[]
): string {
  const pathSelections = selections.filter(
    (
      selection
    ): selection is Extract<
      TuttiExternalReferenceSelection,
      { selectionKind: "path" }
    > => selection.selectionKind === "path"
  );
  let content = appendRichTextLinksToContent(
    value,
    pathSelections.map(({ reference }) => ({
      kind: reference.kind === "folder" ? "folder" : "file",
      name: reference.displayName,
      path: reference.path
    }))
  );
  const existingWorkspaceReferenceKeys = new Set(
    extractRichTextMentionsFromContent(content).flatMap((mention) => {
      const key = workspaceReferenceIdentityKey(mention);
      return key ? [key] : [];
    })
  );
  const mentionMarkdown = selections.flatMap((selection) => {
    if (selection.selectionKind !== "workspace-reference") {
      return [];
    }
    const mention = {
      providerId: "workspace-reference",
      entityId: selection.id,
      label: selection.displayName,
      scope: {
        workspaceId: selection.workspaceId,
        source: selection.source,
        ...(selection.groupId ? { groupId: selection.groupId } : {}),
        ...(selection.fileCount && selection.fileCount > 0
          ? { count: String(selection.fileCount) }
          : {})
      }
    };
    const key = workspaceReferenceIdentityKey(mention);
    if (!key || existingWorkspaceReferenceKeys.has(key)) {
      return [];
    }
    existingWorkspaceReferenceKeys.add(key);
    const markdown = createRichTextMentionMarkdown(mention);
    return markdown ? [markdown] : [];
  });
  if (mentionMarkdown.length === 0) {
    return content;
  }
  content = normalizeRichTextContent(content);
  return content
    ? `${content} ${mentionMarkdown.join(" ")}`
    : mentionMarkdown.join(" ");
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
    ...(input.providerId === "file" &&
    (input.getBridge?.() ?? input.bridge)?.at?.queryDirectory
      ? {
          getItemDirectory(item: TuttiExternalAtQueryResult) {
            return item.directory;
          },
          async queryDirectory(queryInput) {
            const bridge = (input.getBridge?.() ?? input.bridge)?.at;
            if (!bridge?.queryDirectory) {
              throw new Error(
                "Tutti external @ bridge does not support directory browsing."
              );
            }
            return bridge.queryDirectory({
              directoryPath: queryInput.directoryPath,
              maxResults: queryInput.maxResults ?? input.maxResults,
              providerId: input.providerId
            });
          }
        }
      : {}),
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
