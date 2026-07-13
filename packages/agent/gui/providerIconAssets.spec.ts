import { describe, expect, it } from "vitest";
import { migratedAgentGUIProviderIdentityCatalog } from "./providerIdentityCatalog.ts";
import {
  PROVIDER_ICON_ASSETS_BY_ICON_KEY,
  PROVIDER_ICON_ASSET_VARIANTS,
  resolveProviderIconAsset
} from "./providerIconAssets.ts";

describe("provider icon assets", () => {
  it("covers every icon key emitted by the migrated provider catalog", () => {
    for (const identity of migratedAgentGUIProviderIdentityCatalog) {
      expect(
        PROVIDER_ICON_ASSETS_BY_ICON_KEY[identity.iconKey],
        `missing icon assets for ${identity.providerId}:${identity.iconKey}`
      ).toBeDefined();
      for (const variant of PROVIDER_ICON_ASSET_VARIANTS) {
        expect(
          resolveProviderIconAsset(identity.iconKey, variant),
          `missing ${variant} icon for ${identity.providerId}:${identity.iconKey}`
        ).not.toBeNull();
      }
    }
  });

  it("returns null for unknown icon keys instead of a Tutti asset", () => {
    expect(resolveProviderIconAsset("unknown-provider", "rounded")).toBeNull();
    expect(resolveProviderIconAsset(undefined, "manage")).toBeNull();
  });
});
