import type {
  RichTextMentionService,
  RichTextMentionInvalidationSelector
} from "@tutti-os/ui-rich-text/service";
import type { RichTextMentionIdentity } from "@tutti-os/ui-rich-text/types";

/**
 * Exposes the Agent GUI provider catalog without replacing the workspace-owned
 * resolution cache. Providers already owned by the inherited service keep its
 * invalidation subscriptions; Agent GUI-only providers resolve through the
 * surface service that introduced them.
 */
export function composeAgentGUIMentionService(input: {
  inheritedService: RichTextMentionService;
  surfaceService: RichTextMentionService;
}): RichTextMentionService {
  const { inheritedService, surfaceService } = input;
  const inheritedProviderIds = new Set(
    inheritedService.listProviders().map((provider) => provider.id)
  );
  const serviceForIdentity = (
    identity: RichTextMentionIdentity
  ): RichTextMentionService =>
    inheritedProviderIds.has(identity.providerId)
      ? inheritedService
      : surfaceService;

  return {
    listProviders: () => surfaceService.listProviders(),
    getProvider: (providerId) => surfaceService.getProvider(providerId),
    listTriggerConfigs: () => surfaceService.listTriggerConfigs(),
    query: (queryInput) => surfaceService.query(queryInput),
    resolve: (identity) => serviceForIdentity(identity).resolve(identity),
    getSnapshot: (identity) =>
      serviceForIdentity(identity).getSnapshot(identity),
    invalidate(selector?: RichTextMentionInvalidationSelector) {
      inheritedService.invalidate(selector);
      surfaceService.invalidate(selector);
    },
    subscribe(listener, identity) {
      if (identity) {
        return serviceForIdentity(identity).subscribe(listener, identity);
      }
      const unsubscribeInherited = inheritedService.subscribe(listener);
      const unsubscribeSurface = surfaceService.subscribe(listener);
      return () => {
        unsubscribeInherited();
        unsubscribeSurface();
      };
    },
    // The boundary does not own either service. Their creators retain disposal
    // authority so composing a view cannot tear down workspace subscriptions.
    dispose() {}
  };
}
