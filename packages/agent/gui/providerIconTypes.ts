export const PROVIDER_ICON_ASSET_VARIANTS = [
  "manage",
  "providerRail",
  "rounded",
  "sessionColorful",
  "sessionFlat",
  "dock"
] as const;

export type ProviderIconAssetVariant =
  (typeof PROVIDER_ICON_ASSET_VARIANTS)[number];
