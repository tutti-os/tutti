import { describe, expect, it } from "vitest";
import { clearFailedAgentGUIActivationSelection } from "./useAgentGUIConversationSelectionController";

describe("clearFailedAgentGUIActivationSelection", () => {
  it("does not clear a newer external selection", () => {
    const current = {
      lastActiveAgentSessionId: "session-newer",
      provider: "codex" as const
    };

    expect(
      clearFailedAgentGUIActivationSelection(current, "session-failed")
    ).toBe(current);
    expect(
      clearFailedAgentGUIActivationSelection(current, "session-newer")
        .lastActiveAgentSessionId
    ).toBeNull();
  });
});
