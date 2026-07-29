import { describe, expect, it } from "vitest";
import {
  agentGuiWorkbenchEarlyAccessProviders,
  agentGuiWorkbenchProviderLabels,
  isAgentGuiWorkbenchEarlyAccessProvider,
  isAgentGuiWorkbenchProviderVisibleWithEarlyAccess,
  resolveAgentGuiWorkbenchProviderLabel
} from "./providerCatalog.ts";

describe("workbench provider catalog", () => {
  it("provides labels for every provider identity accepted by workbench state", () => {
    expect(resolveAgentGuiWorkbenchProviderLabel("nexight")).toBe("Nexight");
    expect(Object.values(agentGuiWorkbenchProviderLabels)).not.toContain(
      undefined
    );
  });

  it("marks early-access integrations and not stable ones", () => {
    expect(agentGuiWorkbenchEarlyAccessProviders).toContain("openclaw");
    expect(isAgentGuiWorkbenchEarlyAccessProvider("openclaw")).toBe(true);
    expect(isAgentGuiWorkbenchEarlyAccessProvider("codex")).toBe(false);
    expect(isAgentGuiWorkbenchEarlyAccessProvider("claude-code")).toBe(false);
  });

  it("hides early-access providers only while the switch is off; stable ones stay visible", () => {
    // early access off
    expect(
      isAgentGuiWorkbenchProviderVisibleWithEarlyAccess("openclaw", false)
    ).toBe(false);
    expect(
      isAgentGuiWorkbenchProviderVisibleWithEarlyAccess("codex", false)
    ).toBe(true);
    // early access on
    expect(
      isAgentGuiWorkbenchProviderVisibleWithEarlyAccess("openclaw", true)
    ).toBe(true);
    expect(
      isAgentGuiWorkbenchProviderVisibleWithEarlyAccess("codex", true)
    ).toBe(true);
  });
});
