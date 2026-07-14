import { describe, expect, it } from "vitest";
import type { PromptQueueRecord } from "@tutti-os/agent-activity-core";
import { agentGUIQueueStatusFromPromptQueue } from "./agentGuiQueueStatus";

describe("agentGUIQueueStatusFromPromptQueue", () => {
  it("projects the user-stop suspension reason as paused_by_user", () => {
    expect(
      agentGUIQueueStatusFromPromptQueue({
        suspendReason: "user_stop"
      } as PromptQueueRecord)
    ).toBe("paused_by_user");
  });

  it("projects missing and resumed queues as active", () => {
    expect(agentGUIQueueStatusFromPromptQueue(null)).toBe("active");
    expect(
      agentGUIQueueStatusFromPromptQueue({
        suspendReason: null
      } as PromptQueueRecord)
    ).toBe("active");
  });
});
