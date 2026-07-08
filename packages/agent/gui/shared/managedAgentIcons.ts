import { normalizeManagedAgentProvider } from "./managedAgentProviders";
import {
  claudeRoundedUrl,
  codexRoundedUrl,
  cursorColorfulUrl,
  cursorRoundedUrl,
  geminiRoundedUrl,
  hermesRoundedUrl,
  manageAgentClaudeCodeUrl,
  manageAgentCodexUrl,
  manageAgentGeminiUrl,
  manageAgentHermesUrl,
  manageAgentOpenCodeUrl,
  manageAgentTuttiUrl,
  manageAgentOpenclawUrl,
  providerRailClaudeCodeColorfulUrl,
  providerRailCodexColorfulUrl,
  providerRailHermesColorfulUrl,
  providerRailOpenCodeColorfulUrl,
  providerRailTuttiUrl,
  tuttiDocRoundedUrl,
  opencodeRoundedUrl,
  openclawRoundedUrl
} from "../managedAgentIconAssets";

/** Square avatar art for the managed toolchain agents (used by Manage Agents and Launch home Agents floor). */
export const MANAGED_AGENT_ICON_URLS: Record<string, string> = {
  "claude-code": manageAgentClaudeCodeUrl,
  codex: manageAgentCodexUrl,
  cursor: cursorRoundedUrl,
  gemini: manageAgentGeminiUrl,
  hermes: manageAgentHermesUrl,
  tutti: manageAgentTuttiUrl,
  openclaw: manageAgentOpenclawUrl,
  opencode: manageAgentOpenCodeUrl
};

/** Colorful provider rail icons used by AgentGUI's left provider filter. */
export const MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS: Record<string, string> = {
  "claude-code": providerRailClaudeCodeColorfulUrl,
  codex: providerRailCodexColorfulUrl,
  cursor: cursorColorfulUrl,
  hermes: providerRailHermesColorfulUrl,
  tutti: providerRailTuttiUrl,
  opencode: providerRailOpenCodeColorfulUrl
};

/** Rounded avatars for Room status / room activity panel only. */
export const MANAGED_AGENT_ICON_ROUNDED_URLS: Record<string, string> = {
  "claude-code": claudeRoundedUrl,
  codex: codexRoundedUrl,
  cursor: cursorColorfulUrl,
  gemini: geminiRoundedUrl,
  hermes: hermesRoundedUrl,
  tutti: tuttiDocRoundedUrl,
  openclaw: openclawRoundedUrl,
  opencode: opencodeRoundedUrl
};

/** 与 Manage Agents 列表用的方图区分；房间预览弹幕条等仅用圆图 */
const MANAGED_AGENT_ROUNDED_ICON_FALLBACK_URL = tuttiDocRoundedUrl;

export const MANAGED_AGENT_ICON_FALLBACK_URL = manageAgentTuttiUrl;

export function managedAgentRoundedIconUrl(
  provider: string | undefined
): string {
  return (
    MANAGED_AGENT_ICON_ROUNDED_URLS[normalizeManagedAgentProvider(provider)] ??
    MANAGED_AGENT_ROUNDED_ICON_FALLBACK_URL
  );
}
