import { describe, expect, it } from "vitest";
import {
  agentGuiWorkbenchPreviewProviders,
  agentGuiWorkbenchProviderLabels,
  isAgentGuiWorkbenchPreviewProvider,
  isAgentGuiWorkbenchProviderVisibleWithPreview,
  resolveAgentGuiWorkbenchProviderLabel
} from "./providerCatalog.ts";

describe("workbench provider catalog", () => {
  it("provides labels for every provider identity accepted by workbench state", () => {
    expect(resolveAgentGuiWorkbenchProviderLabel("nexight")).toBe("Nexight");
    expect(Object.values(agentGuiWorkbenchProviderLabels)).not.toContain(
      undefined
    );
  });

  it("marks preview agents (hermes) and not stable ones", () => {
    expect(agentGuiWorkbenchPreviewProviders).toContain("hermes");
    expect(isAgentGuiWorkbenchPreviewProvider("hermes")).toBe(true);
    expect(isAgentGuiWorkbenchPreviewProvider("codex")).toBe(false);
    expect(isAgentGuiWorkbenchPreviewProvider("claude-code")).toBe(false);
  });

  it("hides preview providers only while the preview switch is off; stable always visible", () => {
    // preview off
    expect(isAgentGuiWorkbenchProviderVisibleWithPreview("hermes", false)).toBe(
      false
    );
    expect(isAgentGuiWorkbenchProviderVisibleWithPreview("codex", false)).toBe(
      true
    );
    // preview on
    expect(isAgentGuiWorkbenchProviderVisibleWithPreview("hermes", true)).toBe(
      true
    );
    expect(isAgentGuiWorkbenchProviderVisibleWithPreview("codex", true)).toBe(
      true
    );
  });
});
