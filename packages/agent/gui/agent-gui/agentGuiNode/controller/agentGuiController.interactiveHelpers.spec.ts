import { describe, expect, it } from "vitest";
import type { AgentActivityInteraction } from "@tutti-os/agent-activity-core";
import { interactiveApprovalFromInteraction } from "./agentGuiController.interactiveHelpers";

describe("interactiveApprovalFromInteraction", () => {
  it("projects the normalized file-edit approval purpose", () => {
    const interaction: AgentActivityInteraction = {
      agentSessionId: "session-1",
      createdAtUnixMs: 1,
      input: {
        callId: "call-1",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
      },
      kind: "approval",
      metadata: { approvalPurpose: "edit-files" },
      requestId: "request-1",
      status: "pending",
      toolName: "Approval",
      turnId: "turn-1",
      updatedAtUnixMs: 1
    };

    expect(interactiveApprovalFromInteraction(interaction)).toMatchObject({
      approvalPurpose: "edit-files",
      requestId: "request-1"
    });
  });
});
