import type {
  RichTextTrigger,
  RichTextTriggerBoundary,
  RichTextTriggerConfig,
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

function normalizeOptionalThumbnailUrl(
  value: string | null | undefined
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function resolveItemThumbnailUrl<TItem>(
  provider: RichTextTriggerProvider<TItem>,
  item: TItem
): Promise<string | undefined> {
  if (!provider.getItemThumbnailUrl) {
    return undefined;
  }
  try {
    return normalizeOptionalThumbnailUrl(
      await Promise.resolve(provider.getItemThumbnailUrl(item))
    );
  } catch {
    return undefined;
  }
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
            items.map(async (item) => ({
              providerId: provider.id,
              trigger: input.trigger,
              key: provider.getItemKey(item),
              label: provider.getItemLabel(item),
              subtitle: provider.getItemSubtitle?.(item) || undefined,
              thumbnailUrl: await resolveItemThumbnailUrl(provider, item),
              keywords: provider.getItemKeywords?.(item),
              item,
              insertResult: provider.toInsertResult(item)
            }))
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
