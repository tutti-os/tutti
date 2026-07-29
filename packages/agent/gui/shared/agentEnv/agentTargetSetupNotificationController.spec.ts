import { describe, expect, it } from "vitest";
import type {
  AgentHostAgentTargetSetupAction,
  AgentHostAgentTargetSetupState
} from "../../host/agentHostApi.ts";
import { createAgentTargetSetupFailureNotificationController } from "./agentTargetSetupNotificationController.ts";

describe("agent target setup failure notifications", () => {
  it("does not replay an initial failed action", () => {
    const failed = action({ status: "failed", kind: "install" });
    const controller = createAgentTargetSetupFailureNotificationController(
      state(failed)
    );

    expect(controller.observe(state(failed))).toBeNull();
  });

  for (const [kind, from, to, errorMessage, expectedErrorMessage] of [
    ["install", "running", "failed", "  install failed  ", "install failed"],
    ["authenticate", "queued", "interrupted", null, undefined]
  ] as const) {
    it(`reports ${kind} ${from} to ${to} once`, () => {
      const running = action({ status: from, kind });
      const failed = {
        ...running,
        status: to,
        phase: "complete" as const,
        errorMessage
      };
      const controller = createAgentTargetSetupFailureNotificationController(
        state(null)
      );

      expect(controller.observe(state(running))).toBeNull();
      expect(controller.observe(state(failed))).toEqual({
        actionId: "action-1",
        actionKind: kind,
        errorMessage: expectedErrorMessage,
        kind: "action_failed"
      });
      expect(controller.observe(state(failed))).toBeNull();
    });
  }
});

function action(input: {
  kind: AgentHostAgentTargetSetupAction["kind"];
  status: AgentHostAgentTargetSetupAction["status"];
}): AgentHostAgentTargetSetupAction {
  return {
    actionId: "action-1",
    clientActionId: "client-action-1",
    kind: input.kind,
    status: input.status,
    phase: "installing",
    errorCode: null,
    errorMessage: null
  };
}

function state(
  setupAction: AgentHostAgentTargetSetupAction | null
): AgentHostAgentTargetSetupState {
  return {
    snapshot: {
      agentTargetId: "extension:test",
      status: "failed",
      authMethods: [],
      account: null,
      runtimeSource: null,
      runtimeVersion: null,
      reason: null,
      plan: null,
      action: setupAction
    },
    loading: false,
    failed: false
  };
}
