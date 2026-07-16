import type {
  AgentActivityModelPlanSummary,
  AgentActivityModelPlanModel
} from "@tutti-os/agent-activity-core";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import type { AgentGUIComposerSettingOption } from "./agentGuiNodeTypes";
import type { AgentGUISharedAgentAccess } from "../../../types";
import { agentGUISharedAgentAllowsModel } from "../../../sharedAgentAccess";
import { agentGUISharedAgentAllowsPolicy } from "../../../sharedAgentAccess";

export interface AggregatedModelCopy {
  billingApiMetered: string;
  billingSubscriptionQuota: string;
  capabilities(value: string): string;
  effectNewSession: string;
  effectNextCall: string;
  pricing(input: string, output: string): string;
  tier(value: string): string;
}

export function aggregateCompatibleModelPlanOptions(input: {
  activeSession: boolean;
  copy: AggregatedModelCopy;
  currentModelPlanId?: string | null;
  currentModel?: string | null;
  plans: readonly AgentActivityModelPlanSummary[];
  protocol: string;
  sharedAccess?: AgentGUISharedAgentAccess | null;
}): AgentGUIComposerSettingOption[] {
  const protocol = input.protocol.trim().toLowerCase();
  if (!protocol) return [];
  const upgradesAllowed = agentGUISharedAgentAllowsPolicy(
    input.sharedAccess,
    "upgrade"
  );
  const currentModelPlanId = input.currentModelPlanId?.trim() ?? "";
  const currentModel = input.currentModel?.trim() ?? "";
  return input.plans.flatMap((plan) => {
    const available =
      plan.enabled &&
      (plan.status === "ready" || plan.status === "pending_first_use") &&
      plan.protocol.trim().toLowerCase() === protocol;
    if (!available) return [];
    return plan.models
      .filter((model) => {
        if (
          !upgradesAllowed &&
          input.sharedAccess &&
          (plan.id !== currentModelPlanId || model.id !== currentModel)
        ) {
          return false;
        }
        return agentGUISharedAgentAllowsModel(
          input.sharedAccess,
          plan.id,
          model.id
        );
      })
      .map((model) =>
        aggregatedModelOption({
          activeSession: input.activeSession,
          copy: input.copy,
          currentModelPlanId: input.currentModelPlanId,
          model,
          plan
        })
      );
  });
}

export function modelPlanSelectionValue(
  planId: string,
  modelId: string
): string {
  return `model-plan:${encodeURIComponent(planId.trim())}:${encodeURIComponent(modelId.trim())}`;
}

export function composerModelPlanRequiresNewSession(input: {
  activeSettings: AgentSessionComposerSettings;
  draftSettings: AgentSessionComposerSettings | null;
}): boolean {
  const draftModelPlanID = input.draftSettings?.modelPlanId?.trim() ?? "";
  if (!draftModelPlanID) return false;
  return draftModelPlanID !== (input.activeSettings.modelPlanId?.trim() ?? "");
}

function aggregatedModelOption(input: {
  activeSession: boolean;
  copy: AggregatedModelCopy;
  currentModelPlanId?: string | null;
  model: AgentActivityModelPlanModel;
  plan: AgentActivityModelPlanSummary;
}): AgentGUIComposerSettingOption {
  const model = input.model.id.trim();
  const planID = input.plan.id.trim();
  const effect =
    input.activeSession && input.currentModelPlanId?.trim() !== planID
      ? ("new_session" as const)
      : ("next_call" as const);
  const metadata = [
    input.plan.name.trim(),
    ...(input.plan.billingMode === "api_metered"
      ? [input.copy.billingApiMetered]
      : input.plan.billingMode === "subscription_quota"
        ? [input.copy.billingSubscriptionQuota]
        : []),
    input.copy.tier(input.model.tier?.trim() || "standard")
  ];
  const capabilities = (input.model.capabilities ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  if (capabilities.length > 0) {
    metadata.push(input.copy.capabilities(capabilities.join(", ")));
  }
  if (input.plan.billingMode === "api_metered" && input.model.pricing) {
    metadata.push(
      input.copy.pricing(
        formatPrice(
          input.model.pricing.currency,
          input.model.pricing.inputMicrosPerMillion
        ),
        formatPrice(
          input.model.pricing.currency,
          input.model.pricing.outputMicrosPerMillion
        )
      )
    );
  }
  metadata.push(
    effect === "new_session"
      ? input.copy.effectNewSession
      : input.copy.effectNextCall
  );
  return {
    value: modelPlanSelectionValue(planID, model),
    model,
    modelPlanId: planID,
    sourceName: input.plan.name,
    tier: input.model.tier ?? "standard",
    capabilities,
    effect,
    label: input.model.name.trim() || model,
    description: metadata.join(" · ")
  };
}

function formatPrice(currency: string, micros: number): string {
  const amount = Math.max(0, micros) / 1_000_000;
  return `${currency.trim().toUpperCase() || "USD"} ${amount.toLocaleString(
    undefined,
    {
      maximumFractionDigits: 4
    }
  )}`;
}
