import { describe, expect, it } from "vitest";
import { supportsAgentSideConversation } from "./agentSideConversationRuntime";

describe("supportsAgentSideConversation", () => {
  const supported = {
    supported: true,
    activeSourceTurn: true,
    ephemeral: true,
    hideInheritedTurns: true,
    modelBoundaryInjected: true
  };

  it("requires every mandatory live-runtime capability", () => {
    expect(supportsAgentSideConversation(supported)).toBe(true);
    for (const key of Object.keys(supported) as Array<keyof typeof supported>) {
      expect(
        supportsAgentSideConversation({ ...supported, [key]: false })
      ).toBe(false);
    }
  });
});
