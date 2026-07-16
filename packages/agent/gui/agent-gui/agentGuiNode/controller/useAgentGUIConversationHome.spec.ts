import { describe, expect, it } from "vitest";
import { applyAgentGUIPrefillComposerAssignment } from "./useAgentGUIConversationHome";

describe("Agent GUI prefill composer assignment", () => {
  it("applies the selected Model Plan and model to the target-scoped new-session draft", () => {
    const next = applyAgentGUIPrefillComposerAssignment(
      {
        agentTargetId: "local:codex",
        composerOverridesByAgentTargetId: {
          "local:codex": { permissionModeId: "read-only" }
        },
        lastActiveAgentSessionId: null,
        provider: "codex"
      },
      { model: " gpt-5.4 ", modelPlanId: " plan-codex " }
    );

    expect(
      next.composerOverridesByAgentTargetId?.["local:codex"]
    ).toMatchObject({
      model: "gpt-5.4",
      modelPlanId: "plan-codex",
      permissionModeId: "read-only"
    });
  });

  it("does not change draft state without an assignment", () => {
    const current = {
      agentTargetId: "local:codex",
      lastActiveAgentSessionId: null,
      provider: "codex"
    };

    expect(
      applyAgentGUIPrefillComposerAssignment(current, {
        model: " ",
        modelPlanId: null
      })
    ).toBe(current);
  });
});
