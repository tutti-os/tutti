import { describe, expect, it } from "vitest";
import {
  aggregateCompatibleModelPlanOptions,
  composerModelPlanRequiresNewSession
} from "./composerAggregatedModelPlans";

const copy = {
  billingApiMetered: "API metered",
  billingSubscriptionQuota: "Subscription quota",
  capabilities: (value: string) => `Capabilities: ${value}`,
  effectNewSession: "New session",
  effectNextCall: "Next call",
  pricing: (input: string, output: string) => `In ${input}; out ${output}`,
  tier: (value: string) => value
};

describe("aggregateCompatibleModelPlanOptions", () => {
  it("keeps only authorized compatible plans and preserves source metadata", () => {
    const options = aggregateCompatibleModelPlanOptions({
      activeSession: true,
      copy,
      currentModelPlanId: "plan-current",
      protocol: "openai",
      plans: [
        {
          id: "plan-current",
          name: "Current",
          billingMode: "api_metered",
          protocol: "openai",
          enabled: true,
          status: "ready",
          models: [{ id: "gpt-a", name: "GPT A", tier: "flagship" }]
        },
        {
          id: "plan-other",
          name: "Other",
          billingMode: "subscription_quota",
          protocol: "openai",
          enabled: true,
          status: "pending_first_use",
          models: [{ id: "gpt-b", name: "GPT B", capabilities: ["vision"] }]
        },
        {
          id: "disabled",
          name: "Disabled",
          protocol: "openai",
          enabled: false,
          status: "ready",
          models: [{ id: "hidden", name: "Hidden" }]
        },
        {
          id: "anthropic",
          name: "Anthropic",
          protocol: "anthropic",
          enabled: true,
          status: "ready",
          models: [{ id: "claude", name: "Claude" }]
        }
      ]
    });
    expect(options.map((option) => option.model)).toEqual(["gpt-a", "gpt-b"]);
    expect(options.map((option) => option.effect)).toEqual([
      "next_call",
      "new_session"
    ]);
    expect(options[1]?.description).toContain("Other");
    expect(options[1]?.description).toContain("Capabilities: vision");
    expect(options[1]?.description).toContain("Subscription quota");
  });

  it("shows monetary unit prices only for API-metered plans", () => {
    const model = {
      id: "model-1",
      name: "Model One",
      pricing: {
        currency: "USD",
        inputMicrosPerMillion: 1_000_000,
        outputMicrosPerMillion: 2_000_000,
        cacheReadMicrosPerMillion: 0,
        cacheWriteMicrosPerMillion: 0
      }
    };
    const options = aggregateCompatibleModelPlanOptions({
      activeSession: false,
      copy,
      protocol: "openai",
      plans: [
        {
          id: "api",
          name: "API",
          billingMode: "api_metered",
          protocol: "openai",
          enabled: true,
          status: "ready",
          models: [model]
        },
        {
          id: "subscription",
          name: "Subscription",
          billingMode: "subscription_quota",
          protocol: "openai",
          enabled: true,
          status: "ready",
          models: [model]
        }
      ]
    });

    expect(options[0]?.description).toContain("In USD 1; out USD 2");
    expect(options[1]?.description).toContain("Subscription quota");
    expect(options[1]?.description).not.toContain("USD");
  });

  it("intersects shared-Agent model choices with the Owner allowance", () => {
    const options = aggregateCompatibleModelPlanOptions({
      activeSession: false,
      copy,
      protocol: "openai",
      sharedAccess: {
        grantId: "grant-1",
        ownerUserId: "owner-1",
        ownerOnline: true,
        auditRequired: true,
        allowedModels: [{ modelPlanId: "plan-1", model: "allowed" }]
      },
      plans: [
        {
          id: "plan-1",
          name: "Owner API",
          billingMode: "api_metered",
          protocol: "openai",
          enabled: true,
          status: "ready",
          models: [
            { id: "allowed", name: "Allowed" },
            { id: "blocked", name: "Blocked" }
          ]
        }
      ]
    });

    expect(options.map((option) => option.model)).toEqual(["allowed"]);
  });

  it("keeps a shared Agent on its current route when Owner policy forbids upgrades", () => {
    const options = aggregateCompatibleModelPlanOptions({
      activeSession: true,
      copy,
      currentModelPlanId: "plan-1",
      currentModel: "current",
      protocol: "openai",
      sharedAccess: {
        grantId: "grant-1",
        ownerUserId: "owner-1",
        ownerOnline: true,
        auditRequired: true,
        policyPermissions: {
          consult: true,
          review: true,
          delegate: true,
          upgrade: false
        }
      },
      plans: [
        {
          id: "plan-1",
          name: "Current Plan",
          protocol: "openai",
          enabled: true,
          status: "ready",
          models: [
            { id: "current", name: "Current" },
            { id: "stronger", name: "Stronger" }
          ]
        },
        {
          id: "plan-2",
          name: "Other Plan",
          protocol: "openai",
          enabled: true,
          status: "ready",
          models: [{ id: "other", name: "Other" }]
        }
      ]
    });

    expect(options.map((option) => [option.modelPlanId, option.model])).toEqual(
      [["plan-1", "current"]]
    );
  });
});

describe("composerModelPlanRequiresNewSession", () => {
  it("distinguishes a same-Plan hot model switch from a cross-Plan boundary", () => {
    expect(
      composerModelPlanRequiresNewSession({
        activeSettings: { modelPlanId: "plan-1", model: "gpt-a" },
        draftSettings: { modelPlanId: "plan-1", model: "gpt-b" }
      })
    ).toBe(false);
    expect(
      composerModelPlanRequiresNewSession({
        activeSettings: { modelPlanId: "plan-1", model: "gpt-a" },
        draftSettings: { modelPlanId: "plan-2", model: "gpt-b" }
      })
    ).toBe(true);
  });
});
