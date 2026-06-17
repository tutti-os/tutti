import {
  createRichTextMentionAttrs,
  resolveRichTextMentionView
} from "./mention.ts";
import type {
  RichTextMentionPlugin,
  RichTextMentionQueryInput,
  RichTextMentionQueryMatch,
  RichTextMentionRegistry,
  RichTextMentionResolveInput,
  RichTextResolvedMentionView
} from "../types/mention.ts";

function normalizePluginId(pluginId: string): string {
  return pluginId.trim();
}

export function createRichTextMentionRegistry(
  plugins: readonly RichTextMentionPlugin[]
): RichTextMentionRegistry {
  const pluginMap = new Map<string, RichTextMentionPlugin>();

  for (const plugin of plugins) {
    const pluginId = normalizePluginId(plugin.id);
    if (!pluginId) {
      throw new Error("Rich text mention plugin id is required.");
    }
    if (pluginMap.has(pluginId)) {
      throw new Error(`Duplicate rich text mention plugin id: ${pluginId}`);
    }
    pluginMap.set(pluginId, plugin);
  }

  async function query(
    input: RichTextMentionQueryInput
  ): Promise<readonly RichTextMentionQueryMatch[]> {
    const matches = await Promise.all(
      [...pluginMap.values()].map(async (plugin) => {
        const items = await plugin.query(input);
        return items.map<RichTextMentionQueryMatch>((item) => ({
          pluginId: plugin.id,
          key: plugin.getItemKey(item),
          label: plugin.getItemLabel(item),
          subtitle: plugin.getItemSubtitle?.(item) || undefined,
          keywords: plugin.getItemKeywords?.(item),
          item,
          mention: createRichTextMentionAttrs(plugin.id, plugin.toMention(item))
        }));
      })
    );

    const flatMatches = matches.flat();
    const limit = input.maxResults;
    if (typeof limit === "number" && limit >= 0) {
      return flatMatches.slice(0, limit);
    }
    return flatMatches;
  }

  async function resolve(
    input: RichTextMentionResolveInput
  ): Promise<RichTextResolvedMentionView> {
    const plugin = pluginMap.get(input.mention.providerId);
    if (!plugin) {
      return resolveRichTextMentionView(input.mention, {
        state: "missing"
      });
    }

    if (!plugin.resolveMention) {
      return resolveRichTextMentionView(input.mention, {
        state: "active"
      });
    }

    return resolveRichTextMentionView(
      input.mention,
      await plugin.resolveMention(input)
    );
  }

  return {
    listPlugins: () => [...pluginMap.values()],
    getPlugin: (pluginId: string) => pluginMap.get(normalizePluginId(pluginId)),
    query,
    resolve
  };
}
