import { describe, expect, it } from "vitest";
import { agentGuiDockIconUrl, agentGuiDockIconUrls } from "./dockIcons.ts";
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
} from "./managedAgentIconAssets.ts";
import {
  MANAGED_AGENT_ICON_FALLBACK_URL,
  MANAGED_AGENT_ICON_ROUNDED_URLS,
  MANAGED_AGENT_ICON_URLS
} from "./shared/managedAgentIcons.ts";

function expectPackagedIconUrl(url: string): void {
  expect(url).toEqual(expect.any(String));
  expect(url.length).toBeGreaterThan(0);
  expect(url).not.toContain("undefined");
  expect(url).not.toContain("/node_modules/.vite/deps/");
}

describe("managed agent icon assets", () => {
  it("exposes concrete package icon URLs for every managed agent provider", () => {
    [
      ...Object.values(MANAGED_AGENT_ICON_URLS),
      ...Object.values(MANAGED_AGENT_ICON_ROUNDED_URLS),
      MANAGED_AGENT_ICON_FALLBACK_URL,
      agentGuiDockIconUrl,
      ...Object.values(agentGuiDockIconUrls)
    ].forEach(expectPackagedIconUrl);
  });

  it("reuses identical provider artwork across manage, rounded, and dock maps", () => {
    expect(manageAgentClaudeCodeUrl).toBe(claudeRoundedUrl);
    expect(manageAgentCodexUrl).toBe(codexRoundedUrl);
    expect(manageAgentGeminiUrl).toBe(geminiRoundedUrl);
    expect(manageAgentHermesUrl).toBe(hermesRoundedUrl);
    expect(manageAgentTuttiUrl).toBe(tuttiDocRoundedUrl);
    expect(manageAgentOpenclawUrl).toBe(openclawRoundedUrl);

    expect(agentGuiDockIconUrls["claude-code"]).toBe(claudeRoundedUrl);
    expect(agentGuiDockIconUrls.codex).toBe(codexRoundedUrl);
    expect(agentGuiDockIconUrls.gemini).toBe(geminiRoundedUrl);
    expect(agentGuiDockIconUrls.hermes).toBe(hermesRoundedUrl);
    expect(agentGuiDockIconUrls.nexight).toBe(tuttiDocRoundedUrl);
    expect(agentGuiDockIconUrls.openclaw).toBe(openclawRoundedUrl);
  });
});
