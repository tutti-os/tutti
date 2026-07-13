import {
  claudeCodeFlatFilledIconUrl,
  codexFlatFilledIconUrl,
  cursorFlatFilledIconUrl,
  opencodeFlatFilledIconUrl,
  resolveProviderIconAsset,
  tuttiFlatFilledIconUrl
} from "./providerIconAssets.ts";
import { resolveAgentGUIProviderCatalogIdentity } from "./providerIdentityCatalog.ts";
import { cursorColorfulUrl } from "./managedAgentIconAssets.ts";
import { normalizeManagedAgentProvider } from "./shared/managedAgentProviders";

export {
  claudeCodeFlatFilledIconUrl,
  codexFlatFilledIconUrl,
  cursorColorfulUrl,
  cursorFlatFilledIconUrl,
  opencodeFlatFilledIconUrl,
  tuttiFlatFilledIconUrl
};

/**
 * Colorful session icons, used where the icon renders as a real <img> avatar
 * (collapsed workbench header, dock popup). Colorful assets keep their fill.
 */
export function resolveAgentGuiSessionProviderIconUrl(
  provider: string | undefined
): string | null {
  const identity = resolveAgentGUIProviderCatalogIdentity(
    normalizeManagedAgentProvider(provider)
  );
  return resolveProviderIconAsset(identity?.iconKey, "sessionColorful");
}

/**
 * Flat monochrome session icons, used where the icon renders through a CSS
 * mask (e.g. the conversation rail rows). Colorful assets would collapse to a
 * solid square under a mask, so these must be single-color glyphs with a
 * transparent background.
 */
export function resolveAgentGuiSessionProviderFlatIconUrl(
  provider: string | undefined
): string | null {
  const identity = resolveAgentGUIProviderCatalogIdentity(
    normalizeManagedAgentProvider(provider)
  );
  return resolveProviderIconAsset(identity?.iconKey, "sessionFlat");
}
