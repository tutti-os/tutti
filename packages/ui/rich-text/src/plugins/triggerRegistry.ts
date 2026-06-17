import type {
  RichTextTrigger,
  RichTextTriggerBoundary,
  RichTextTriggerConfig,
  RichTextTriggerInsertResult,
  RichTextTriggerProvider,
  RichTextTriggerQueryInput,
  RichTextTriggerQueryMatch,
  RichTextTriggerRegistry
} from "../types/trigger.ts";

function normalizeProviderId(providerId: string): string {
  return providerId.trim();
}

function normalizeProviderTrigger(
  provider: RichTextTriggerProvider
): RichTextTrigger {
  return provider.trigger;
}

function normalizeProviderBoundary(
  provider: RichTextTriggerProvider
): RichTextTriggerBoundary {
  return provider.boundary ?? "punctuation";
}

function normalizeProviderTriggerConfig(
  provider: RichTextTriggerProvider
): RichTextTriggerConfig {
  return {
    trigger: normalizeProviderTrigger(provider),
    boundary: normalizeProviderBoundary(provider)
  };
}

function normalizeOptionalIconUrl(
  value: string | null | undefined
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveInsertResultIconUrl(
  insertResult: RichTextTriggerInsertResult
): string | undefined {
  if (insertResult.kind !== "mention") {
    return undefined;
  }
  return normalizeOptionalIconUrl(insertResult.mention.presentation?.iconUrl);
}

async function resolveItemIconUrl<TItem>(
  provider: RichTextTriggerProvider<TItem>,
  item: TItem,
  insertResult: RichTextTriggerInsertResult
): Promise<string | undefined> {
  if (provider.getItemIconUrl) {
    try {
      const iconUrl = normalizeOptionalIconUrl(
        await Promise.resolve(provider.getItemIconUrl(item))
      );
      if (iconUrl) {
        return iconUrl;
      }
    } catch {
      return resolveInsertResultIconUrl(insertResult);
    }
  }
  return resolveInsertResultIconUrl(insertResult);
}

export function createRichTextTriggerRegistry(
  providers: readonly RichTextTriggerProvider[]
): RichTextTriggerRegistry {
  const providerMap = new Map<string, RichTextTriggerProvider>();
  const triggerConfigKeys = new Set<string>();
  const triggerConfigs: RichTextTriggerConfig[] = [];

  for (const provider of providers) {
    const providerId = normalizeProviderId(provider.id);
    if (!providerId) {
      throw new Error("Rich text trigger provider id is required.");
    }
    if (providerMap.has(providerId)) {
      throw new Error(`Duplicate rich text trigger provider id: ${providerId}`);
    }
    providerMap.set(providerId, provider);
    const triggerConfig = normalizeProviderTriggerConfig(provider);
    const triggerConfigKey = `${triggerConfig.trigger}:${triggerConfig.boundary}`;
    if (!triggerConfigKeys.has(triggerConfigKey)) {
      triggerConfigKeys.add(triggerConfigKey);
      triggerConfigs.push(triggerConfig);
    }
  }

  async function query(
    input: RichTextTriggerQueryInput
  ): Promise<readonly RichTextTriggerQueryMatch[]> {
    if (input.abortSignal?.aborted) {
      return [];
    }

    const matches = await Promise.all(
      [...providerMap.values()]
        .filter(
          (provider) => normalizeProviderTrigger(provider) === input.trigger
        )
        .map(async (provider) => {
          if (input.abortSignal?.aborted) {
            return [];
          }
          const items = await provider.query(input);
          if (input.abortSignal?.aborted) {
            return [];
          }
          return Promise.all(
            items.map(async (item) => {
              const insertResult = provider.toInsertResult(item);
              return {
                providerId: provider.id,
                trigger: input.trigger,
                key: provider.getItemKey(item),
                label: provider.getItemLabel(item),
                subtitle: provider.getItemSubtitle?.(item) || undefined,
                iconUrl: await resolveItemIconUrl(provider, item, insertResult),
                keywords: provider.getItemKeywords?.(item),
                item,
                insertResult
              };
            })
          );
        })
    );

    const flatMatches = matches.flat();
    const limit = input.maxResults;
    if (typeof limit === "number" && limit >= 0) {
      return flatMatches.slice(0, limit);
    }
    return flatMatches;
  }

  return {
    listProviders: () => [...providerMap.values()],
    getProvider: (providerId: string) =>
      providerMap.get(normalizeProviderId(providerId)),
    listTriggerConfigs: () => [...triggerConfigs],
    query
  };
}
