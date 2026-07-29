import { describe, expect, it } from "vitest";
import {
  agentGUISharedAgentAllowsModel,
  agentGUISharedAgentAllowsPolicy,
  agentGUISharedAgentUnavailableReason,
  normalizeAgentGUISharedAgentAccess
} from "./sharedAgentAccess";

describe("shared Agent access projection", () => {
  const access = {
    grantId: " grant-1 ",
    ownerUserId: " owner-1 ",
    ownerOnline: true,
    auditRequired: true,
    costQuota: {
      currency: " usd ",
      remainingMicros: 250_000,
      limitMicros: 1_000_000
    },
    allowedModels: [
      { modelPlanId: " plan-1 ", model: " model-a " },
      { modelPlanId: "plan-1", model: "model-a" }
    ],
    policyPermissions: {
      consult: true,
      review: true,
      delegate: false,
      upgrade: false
    }
  } as const;

  it("normalizes model, cost, and policy restrictions without credentials", () => {
    expect(normalizeAgentGUISharedAgentAccess(access)).toMatchObject({
      grantId: "grant-1",
      ownerUserId: "owner-1",
      costQuota: {
        currency: "USD",
        remainingMicros: 250_000,
        limitMicros: 1_000_000
      },
      allowedModels: [{ modelPlanId: "plan-1", model: "model-a" }]
    });
    expect(agentGUISharedAgentAllowsModel(access, "plan-1", "model-a")).toBe(
      true
    );
    expect(agentGUISharedAgentAllowsModel(access, "plan-1", "model-b")).toBe(
      false
    );
    expect(
      agentGUISharedAgentAllowsModel(
        { ...access, allowedModels: [{ model: "model-a" }] },
        "another-compatible-plan",
        "model-a"
      )
    ).toBe(true);
    expect(agentGUISharedAgentAllowsPolicy(access, "delegate")).toBe(false);
    expect(agentGUISharedAgentAllowsPolicy(access, "review")).toBe(true);
  });

  it("disables new calls when the Owner cost allowance is exhausted", () => {
    expect(
      agentGUISharedAgentUnavailableReason({
        ...access,
        costQuota: { currency: "USD", remainingMicros: 0 }
      })
    ).toBe("share_cost_limit_exhausted");
  });
});
