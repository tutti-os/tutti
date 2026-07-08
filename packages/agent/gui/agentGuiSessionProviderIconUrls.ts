import claudeCodeFlatFilledIconUrl from "./app/renderer/assets/icons/agents/claudecode-flat-filled.svg";
import codexFlatFilledIconUrl from "./app/renderer/assets/icons/agents/codex-flat-filled.svg";
import cursorFlatFilledIconUrl from "./app/renderer/assets/icons/agents/cursor-flat-filled.svg";
import opencodeFlatFilledIconUrl from "./app/renderer/assets/icons/agents/opencode-flat-filled.svg";
import tuttiFlatFilledIconUrl from "./app/renderer/assets/icons/agents/tutti-flat-filled.svg";
import {
  claudeRoundedUrl,
  codexRoundedUrl,
  cursorColorfulUrl,
  manageAgentTuttiUrl,
  opencodeRoundedUrl
} from "./managedAgentIconAssets";
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
  switch (normalizeManagedAgentProvider(provider)) {
    case "claude-code":
      return claudeRoundedUrl;
    case "codex":
      return codexRoundedUrl;
    case "cursor":
      return cursorColorfulUrl;
    case "opencode":
      return opencodeRoundedUrl;
    case "tutti":
      return manageAgentTuttiUrl;
    default:
      return null;
  }
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
  switch (normalizeManagedAgentProvider(provider)) {
    case "claude-code":
      return claudeCodeFlatFilledIconUrl;
    case "codex":
      return codexFlatFilledIconUrl;
    case "cursor":
      return cursorFlatFilledIconUrl;
    case "opencode":
      return opencodeFlatFilledIconUrl;
    case "tutti":
      return tuttiFlatFilledIconUrl;
    default:
      return null;
  }
}
