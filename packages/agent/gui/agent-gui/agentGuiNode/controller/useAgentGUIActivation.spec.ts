import { describe, expect, it } from "vitest";
import { isPendingNewConversationActivationForSession } from "./useAgentGUIActivation";

describe("isPendingNewConversationActivationForSession", () => {
  const pendingActivation = {
    agentSessionId: "session-pending",
    mode: "new" as const,
    status: "requested" as const
  };

  it("preserves only the session owned by the pending activation", () => {
    expect(
      isPendingNewConversationActivationForSession(
        pendingActivation,
        "session-pending"
      )
    ).toBe(true);
    expect(
      isPendingNewConversationActivationForSession(
        pendingActivation,
        "session-previous"
      )
    ).toBe(false);
  });
});
