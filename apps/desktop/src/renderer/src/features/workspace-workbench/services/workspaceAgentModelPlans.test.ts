import assert from "node:assert/strict";
import test from "node:test";
import { workspaceAgentCompatibleModelPlans } from "./workspaceAgentModelPlans.ts";
import type {
  WorkspaceModelPlan,
  WorkspaceModelPlanProtocol,
  WorkspaceModelPlanTemplateKind
} from "./workspaceSettingsTypes.ts";

test("plan selector covers every compatible template kind by protocol", () => {
  const plans = [
    createPlan("plan-subscription", "official_subscription", "anthropic"),
    createPlan("plan-coding", "coding_plan", "anthropic"),
    createPlan("plan-domestic", "domestic", "anthropic"),
    createPlan("plan-custom", "custom", "anthropic"),
    createPlan("plan-openai", "custom", "openai")
  ];

  assert.deepEqual(
    workspaceAgentCompatibleModelPlans(plans, "anthropic", "").map(
      (plan) => plan.id
    ),
    ["plan-subscription", "plan-coding", "plan-domestic", "plan-custom"]
  );
  assert.deepEqual(
    workspaceAgentCompatibleModelPlans(plans, "openai", "").map(
      (plan) => plan.id
    ),
    ["plan-openai"]
  );
});

test("plan selector hides disabled plans unless currently selected", () => {
  const plans = [
    createPlan("plan-ready", "official_subscription", "anthropic"),
    { ...createPlan("plan-off", "coding_plan", "anthropic"), enabled: false }
  ];

  assert.deepEqual(
    workspaceAgentCompatibleModelPlans(plans, "anthropic", "").map(
      (plan) => plan.id
    ),
    ["plan-ready"]
  );
  assert.deepEqual(
    workspaceAgentCompatibleModelPlans(plans, "anthropic", "plan-off").map(
      (plan) => plan.id
    ),
    ["plan-ready", "plan-off"]
  );
});

test("plan selector keeps only the current selection without a protocol", () => {
  const plans = [
    createPlan("plan-a", "custom", "openai"),
    createPlan("plan-b", "custom", "anthropic")
  ];

  assert.deepEqual(workspaceAgentCompatibleModelPlans(plans, null, ""), []);
  assert.deepEqual(
    workspaceAgentCompatibleModelPlans(plans, null, "plan-b").map(
      (plan) => plan.id
    ),
    ["plan-b"]
  );
});

function createPlan(
  id: string,
  templateKind: WorkspaceModelPlanTemplateKind,
  protocol: WorkspaceModelPlanProtocol
): WorkspaceModelPlan {
  return {
    id,
    workspaceId: "workspace-1",
    name: id,
    templateKind,
    protocol,
    hasApiKey: templateKind !== "official_subscription",
    models: [],
    defaultModel: "",
    enabled: true,
    status: "ready",
    detection: { stages: [] },
    createdAt: "2026-07-17T00:00:00Z",
    updatedAt: "2026-07-17T00:00:00Z"
  };
}
