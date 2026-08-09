import { describe, expect, it } from "vitest";
import { resolveAgentGUIInteractionReadinessIdentity } from "./agentGuiController.interactionHelpers";

describe("resolveAgentGUIInteractionReadinessIdentity", () => {
  it("normalizes the complete identity carried by the canonical prompt", () => {
    expect(
      resolveAgentGUIInteractionReadinessIdentity({
        agentSessionId: " session-1 ",
        requestId: " request-1 ",
        turnId: " turn-1 ",
        workspaceId: " workspace-1 "
      })
    ).toEqual({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      turnId: "turn-1",
      requestId: "request-1"
    });
  });

  it.each(["agentSessionId", "turnId", "requestId"] as const)(
    "fails closed when the prompt omits %s",
    (field) => {
      expect(
        resolveAgentGUIInteractionReadinessIdentity({
          agentSessionId: field === "agentSessionId" ? null : "session-1",
          requestId: field === "requestId" ? null : "request-1",
          turnId: field === "turnId" ? null : "turn-1",
          workspaceId: "workspace-1"
        })
      ).toBeNull();
    }
  );
});
