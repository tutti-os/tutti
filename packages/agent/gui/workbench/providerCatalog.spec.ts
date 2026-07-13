import { describe, expect, it } from "vitest";
import {
  agentGuiWorkbenchProviderLabels,
  resolveAgentGuiWorkbenchProviderLabel
} from "./providerCatalog.ts";

describe("workbench provider catalog", () => {
  it("provides labels for every provider identity accepted by workbench state", () => {
    expect(resolveAgentGuiWorkbenchProviderLabel("nexight")).toBe("Nexight");
    expect(Object.values(agentGuiWorkbenchProviderLabels)).not.toContain(
      undefined
    );
  });
});
