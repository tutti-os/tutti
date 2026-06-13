import { normalizeManagedAgentProvider } from "./managedAgentProviders";
import {
  claudeRoundedUrl,
  codexRoundedUrl,
  geminiRoundedUrl,
  hermesRoundedUrl,
  manageAgentClaudeCodeUrl,
  manageAgentCodexUrl,
  manageAgentGeminiUrl,
  manageAgentHermesUrl,
  manageAgentTuttiUrl,
  manageAgentOpenclawUrl,
  tuttiDocRoundedUrl,
  openclawRoundedUrl
} from "../managedAgentIconAssets";

/** Square avatar art for the managed toolchain agents (used by Manage Agents and Launch home Agents floor). */
export const MANAGED_AGENT_ICON_URLS: Record<string, string> = {
  "claude-code": manageAgentClaudeCodeUrl,
  codex: manageAgentCodexUrl,
  gemini: manageAgentGeminiUrl,
  hermes: manageAgentHermesUrl,
  tutti: manageAgentTuttiUrl,
  openclaw: manageAgentOpenclawUrl
};

/** Rounded avatars for Room status / room activity panel only. */
export const MANAGED_AGENT_ICON_ROUNDED_URLS: Record<string, string> = {
  "claude-code": claudeRoundedUrl,
  codex: codexRoundedUrl,
  gemini: geminiRoundedUrl,
  hermes: hermesRoundedUrl,
  tutti: tuttiDocRoundedUrl,
  openclaw: openclawRoundedUrl
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
