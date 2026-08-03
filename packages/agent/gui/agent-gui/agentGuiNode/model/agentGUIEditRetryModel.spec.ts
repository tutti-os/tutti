import { describe, expect, it } from "vitest";
import type {
  AgentActivityEditRetryAvailability,
  AgentActivityEditRetryResult,
} from "@tutti-os/agent-activity-core";
import { projectAgentGUIEditRetryPresentation } from "./agentGUIEditRetryModel";

describe("projectAgentGUIEditRetryPresentation", () => {
  it("treats prepared eligible history as ready", () => {
    expect(
      projectAgentGUIEditRetryPresentation({
        availability: availability({
          eligible: true,
          recoveryState: "prepared",
          turnId: "turn-latest",
        }),
        commandStatus: "idle",
      }),
    ).toMatchObject({
      editableTurnId: "turn-latest",
      state: "ready",
    });
  });

  it("maps command submission, authoritative reconciliation, and rollback to recovering", () => {
    expect(
      projectAgentGUIEditRetryPresentation({
        availability: availability({ recoveryState: "rolling_back" }),
        commandStatus: "idle",
      }).state,
    ).toBe("recovering");
    expect(
      projectAgentGUIEditRetryPresentation({
        availability: availability({ recoveryState: "prepared" }),
        commandStatus: "pending",
      }).state,
    ).toBe("recovering");
    expect(
      projectAgentGUIEditRetryPresentation({
        availability: availability({
          eligible: true,
          recoveryState: "prepared",
          turnId: "turn-latest",
        }),
        commandStatus: "reconciling",
      }),
    ).toMatchObject({
      editableTurnId: null,
      state: "recovering",
    });
  });

  it("maps resend_pending to explicit recovery after rollback is confirmed", () => {
    expect(
      projectAgentGUIEditRetryPresentation({
        availability: availability({
          availableActions: ["reconcile", "retry_replacement"],
          operationId: "operation-1",
          recoveryState: "resend_pending",
        }),
        commandStatus: "idle",
      }),
    ).toMatchObject({
      availableActions: ["reconcile", "retry_replacement"],
      editableTurnId: null,
      operationId: "operation-1",
      state: "action_required",
    });
  });

  it("shows explicit recovery without blocking an eligible retry after a transient command failure", () => {
    expect(
      projectAgentGUIEditRetryPresentation({
        availability: availability({
          eligible: true,
          recoveryState: "prepared",
          turnId: "turn-latest",
        }),
        commandStatus: "failed",
      }),
    ).toMatchObject({
      editableTurnId: "turn-latest",
      state: "ready",
    });
    expect(
      projectAgentGUIEditRetryPresentation({
        availability: availability({
          availableActions: ["reconcile"],
          recoveryState: "recovery_required",
        }),
        commandStatus: "idle",
      }),
    ).toMatchObject({
      availableActions: ["reconcile"],
      editableTurnId: null,
      state: "action_required",
    });
  });

  it("keeps an automatic retry in its own durable retry-wait state", () => {
    expect(
      projectAgentGUIEditRetryPresentation({
        availability: availability({
          automatic: true,
          attempt: 2,
          nextAttemptAtUnixMs: 1234,
          operationId: "operation-1",
          operationVersion: 7,
        }),
        commandStatus: "idle",
      }),
    ).toMatchObject({
      automatic: true,
      attempt: 2,
      nextAttemptAtUnixMs: 1234,
      state: "retry_wait",
    });
  });

  it("requires a positive retry timestamp before presenting retry-wait", () => {
    for (const nextAttemptAtUnixMs of [undefined, 0]) {
      const presentation = projectAgentGUIEditRetryPresentation({
        availability: availability({ automatic: true, operationId: "operation-1", reasonCode: "retry_wait", nextAttemptAtUnixMs }),
        commandStatus: "idle",
      });
      expect(presentation.state).not.toBe("retry_wait");
      expect(presentation.editableTurnId).toBeNull();
      expect(presentation.nextAttemptAtUnixMs).toBeNull();
    }
  });

  it("keeps blocked Host reasons action-required without inventing retry state", () => {
    for (const reasonCode of ["retry_budget_exhausted", "local_state_inconsistent"] as const) {
      expect(projectAgentGUIEditRetryPresentation({
        availability: availability({ automatic: false, availableActions: ["reconcile"], operationId: "operation-1", reasonCode, recoveryState: "recovery_required" }),
        commandStatus: "idle",
      })).toMatchObject({ state: "action_required", automatic: false, nextAttemptAtUnixMs: null, availableActions: ["reconcile"], reasonCode });
    }
  });

  it("retains a completed durable operation as terminal rather than an error", () => {
    expect(
      projectAgentGUIEditRetryPresentation({
        availability: availability({ eligible: false }),
        commandStatus: "succeeded",
        commandResult: {
          historyRevision: 2,
          operationId: "operation-1",
          retractedTurnId: "turn-1",
          state: "completed",
        },
      }),
    ).toMatchObject({ state: "terminal" });
  });

  it("does not invent an abandon action for an unknown provider outcome", () => {
    const presentation = projectAgentGUIEditRetryPresentation({
      availability: availability({
        availableActions: ["reconcile"],
        operationId: "operation-1",
        operationVersion: 7,
        reasonCode: "provider_outcome_unknown",
        recoveryState: "resend_pending",
      }),
      commandStatus: "idle",
    });
    expect(presentation.availableActions).toEqual(["reconcile"]);
    expect(presentation.availableActions).not.toContain("abandon");
  });

  it("keeps rollout-disabled availability distinct from provider support and recovery", () => {
    const presentation = projectAgentGUIEditRetryPresentation({
      availability: availability({
        reasonCode: "rollout_disabled",
        supported: false,
      }),
      commandStatus: "idle",
    });
    expect(presentation).toMatchObject({
      availableActions: [],
      reasonCode: "rollout_disabled",
      state: "action_required",
    });
  });

  it("projects stable reason codes only and never retains provider diagnostics", () => {
    const presentation = projectAgentGUIEditRetryPresentation({
      availability: availability({
        operationId: "operation-1",
        reasonCode: "provider_outcome_unknown",
        recoveryState: "resend_pending",
      }),
      commandStatus: "failed",
      commandResult: {
        operationId: "operation-1",
        retractedTurnId: "turn-1",
        historyRevision: 1,
        state: "resend_pending",
        reasonCode: "provider_outcome_unknown",
        rawDiagnostic: "provider secret diagnostic",
      } as unknown as AgentActivityEditRetryResult,
    });
    expect(JSON.stringify(presentation)).not.toContain(
      "provider secret diagnostic",
    );
    expect(presentation.reasonCode).toBe("provider_outcome_unknown");
  });
});

function availability(
  overrides: Partial<AgentActivityEditRetryAvailability> = {},
): AgentActivityEditRetryAvailability {
  return {
    supported: true,
    eligible: false,
    historyRevision: 1,
    recoveryState: "prepared",
    availableActions: [],
    ...overrides,
  };
}
