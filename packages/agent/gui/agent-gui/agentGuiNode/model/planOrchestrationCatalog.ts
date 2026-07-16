import type { AgentActivityModelPlanSummary } from "@tutti-os/agent-activity-core";
import { resolveAgentGUIProviderCatalogIdentity } from "../../../providerIdentityCatalog";
import type { AgentGUIAgentTarget } from "../../../types";
import type { PlanOrchestrationCatalog } from "../../../shared/agentConversation/planImplementationPresentation";

export function planOrchestrationCatalogFromRuntime(input: {
  agentTargets: readonly AgentGUIAgentTarget[];
  modelPlans: readonly AgentActivityModelPlanSummary[];
}): PlanOrchestrationCatalog {
  return {
    agents: input.agentTargets.map((target) => ({
      agentTargetId: target.agentTargetId?.trim() || target.targetId.trim(),
      name: target.label,
      purpose: target.description?.trim() || "",
      provider: target.provider,
      modelPlanProtocol:
        resolveAgentGUIProviderCatalogIdentity(target.provider)
          ?.modelPlanProtocol || undefined,
      available: target.disabled !== true
    })),
    modelPlans: input.modelPlans.map((plan) => ({
      billingMode: plan.billingMode,
      id: plan.id,
      name: plan.name,
      protocol: plan.protocol,
      status: plan.status,
      available:
        plan.enabled &&
        (plan.status === "pending_first_use" || plan.status === "ready"),
      defaultModel: plan.defaultModel?.trim() || undefined,
      models: plan.models.map((model) => ({
        id: model.id,
        name: model.name,
        tier: model.tier,
        capabilities: model.capabilities,
        pricing: model.pricing
      }))
    }))
  };
}
