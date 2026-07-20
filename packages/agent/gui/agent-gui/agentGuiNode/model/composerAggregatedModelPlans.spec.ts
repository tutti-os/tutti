import { describe, expect, it } from "vitest";

import type { AgentActivityModelPlanSummary } from "@tutti-os/agent-activity-core";

import {
  aggregateCompatibleModelPlanOptions,
  composerModelPlanRequiresNewSession,
  modelPlanSelectionValue
} from "./composerAggregatedModelPlans.ts";

const copy = {
  effectNewSession: "new session",
  effectNextCall: "next call"
};

function plan(overrides: Partial<AgentActivityModelPlanSummary> = {}) {
  return {
    defaultModel: null,
    enabled: true,
    id: "plan-1",
    models: [
      { id: "kimi-k2", name: "Kimi K2" },
      { id: "glm-5", name: "GLM 5" }
    ],
    name: "Relay Plan",
    protocol: "openai",
    status: "ready",
    ...overrides
  } satisfies AgentActivityModelPlanSummary;
}

describe("aggregateCompatibleModelPlanOptions", () => {
  it("maps ready enabled plans with a matching protocol into options", () => {
    const options = aggregateCompatibleModelPlanOptions({
      activeSession: false,
      copy,
      plans: [plan()],
      protocol: "openai"
    });

    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({
      effect: "next_call",
      label: "Kimi K2",
      modelPlanId: "plan-1",
      sourceName: "Relay Plan",
      value: modelPlanSelectionValue("plan-1", "kimi-k2")
    });
    expect(options[0]?.description).toContain("Relay Plan");
    expect(options[0]?.description).toContain(copy.effectNextCall);
  });

  it("drops plans that are disabled, unready, or on another protocol", () => {
    const options = aggregateCompatibleModelPlanOptions({
      activeSession: false,
      copy,
      plans: [
        plan({ enabled: false }),
        plan({ id: "plan-2", status: "undetected" }),
        plan({ id: "plan-3", protocol: "anthropic" }),
        plan({ id: "plan-4", status: "pending_first_use" })
      ],
      protocol: "openai"
    });

    expect(options.map((option) => option.modelPlanId)).toEqual([
      "plan-4",
      "plan-4"
    ]);
  });

  it("returns nothing without a protocol", () => {
    expect(
      aggregateCompatibleModelPlanOptions({
        activeSession: false,
        copy,
        plans: [plan()],
        protocol: " "
      })
    ).toEqual([]);
  });

  it("marks options new_session when an active session sits on another plan", () => {
    const options = aggregateCompatibleModelPlanOptions({
      activeSession: true,
      copy,
      currentModelPlanId: "plan-other",
      plans: [plan()],
      protocol: "openai"
    });

    expect(options.every((option) => option.effect === "new_session")).toBe(
      true
    );
    expect(options[0]?.description).toContain(copy.effectNewSession);
  });

  it("keeps next_call for the plan the active session already uses", () => {
    const options = aggregateCompatibleModelPlanOptions({
      activeSession: true,
      copy,
      currentModelPlanId: "plan-1",
      plans: [plan()],
      protocol: "openai"
    });

    expect(options.every((option) => option.effect === "next_call")).toBe(true);
  });
});

describe("modelPlanSelectionValue", () => {
  it("encodes plan and model into one stable option value", () => {
    expect(modelPlanSelectionValue("plan 1", "kimi/k2")).toBe(
      "model-plan:plan%201:kimi%2Fk2"
    );
  });
});

describe("composerModelPlanRequiresNewSession", () => {
  it("does not require a new session without a staged draft", () => {
    expect(
      composerModelPlanRequiresNewSession({
        activeSettings: { modelPlanId: "plan-1" },
        draftSettings: null
      })
    ).toBe(false);
  });

  it("treats a draft without a plan decision as no change", () => {
    expect(
      composerModelPlanRequiresNewSession({
        activeSettings: { modelPlanId: "plan-1" },
        draftSettings: { model: "gpt-5" }
      })
    ).toBe(false);
  });

  it("keeps the session when the staged plan matches the active plan", () => {
    expect(
      composerModelPlanRequiresNewSession({
        activeSettings: { modelPlanId: "plan-1" },
        draftSettings: { modelPlanId: "plan-1" }
      })
    ).toBe(false);
  });

  it("requires a new session when switching plans", () => {
    expect(
      composerModelPlanRequiresNewSession({
        activeSettings: { modelPlanId: "plan-1" },
        draftSettings: { modelPlanId: "plan-2" }
      })
    ).toBe(true);
  });

  it("requires a new session when explicitly leaving a plan for a native model", () => {
    expect(
      composerModelPlanRequiresNewSession({
        activeSettings: { modelPlanId: "plan-1" },
        draftSettings: { modelPlanId: null, model: "gpt-5" }
      })
    ).toBe(true);
  });

  it("requires a new session when entering a plan from a native session", () => {
    expect(
      composerModelPlanRequiresNewSession({
        activeSettings: { modelPlanId: null },
        draftSettings: { modelPlanId: "plan-1" }
      })
    ).toBe(true);
  });
});
