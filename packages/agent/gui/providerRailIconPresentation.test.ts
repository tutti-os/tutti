import { describe, expect, it } from "vitest";
import { agentGUIProviderRailIconPresentation } from "./agent-gui/agentGuiNode/view/AgentGUIEmptyState";

describe("agentGUIProviderRailIconPresentation", () => {
  it("uses the target primary icon", () => {
    expect(
      agentGUIProviderRailIconPresentation(
        "acp:example",
        "app://example/icon.svg"
      ).iconUrl
    ).toBe("app://example/icon.svg");
  });

  it("uses provider artwork only when no target icon exists", () => {
    expect(agentGUIProviderRailIconPresentation("codex").iconUrl).toBeTruthy();
  });
});
