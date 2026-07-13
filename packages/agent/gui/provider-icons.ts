import { resolveProviderIconAsset as resolveProviderIconAssetInternal } from "./providerIconAssets.ts";
import type { ProviderIconAssetVariant } from "./providerIconTypes.ts";

export type { ProviderIconAssetVariant } from "./providerIconTypes.ts";

export function resolveProviderIconAsset(
  iconKey: string | null | undefined,
  variant: ProviderIconAssetVariant
): string | null {
  return resolveProviderIconAssetInternal(iconKey, variant);
}
