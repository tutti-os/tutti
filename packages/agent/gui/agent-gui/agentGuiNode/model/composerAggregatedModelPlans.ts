import type { AgentActivityModelPlanSummary } from "@tutti-os/agent-activity-core";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import type { AgentGUIComposerSettingOption } from "./agentGuiNodeTypes";

export interface AggregatedModelCopy {
  effectNewSession: string;
  effectNextCall: string;
}

/**
 * Aggregate the workspace's compatible model access plans into composer model
 * options. A plan contributes its models when it is enabled, past detection
 * (ready or pending first use), and speaks the selected provider's protocol.
 * This branch's plan summaries carry no billing/tier metadata yet, so option
 * descriptions stay at plan name plus switch effect.
 */
export function aggregateCompatibleModelPlanOptions(input: {
  activeSession: boolean;
  copy: AggregatedModelCopy;
  currentModelPlanId?: string | null;
  plans: readonly AgentActivityModelPlanSummary[];
  protocol: string;
}): AgentGUIComposerSettingOption[] {
  const protocol = input.protocol.trim().toLowerCase();
  if (!protocol) return [];
  const currentModelPlanId = input.currentModelPlanId?.trim() ?? "";
  return input.plans.flatMap((plan) => {
    const available =
      plan.enabled &&
      (plan.status === "ready" || plan.status === "pending_first_use") &&
      plan.protocol.trim().toLowerCase() === protocol;
    if (!available) return [];
    return plan.models.map((model) => {
      const effect =
        input.activeSession && currentModelPlanId !== plan.id.trim()
          ? ("new_session" as const)
          : ("next_call" as const);
      const metadata = [
        plan.name.trim(),
        effect === "new_session"
          ? input.copy.effectNewSession
          : input.copy.effectNextCall
      ];
      return {
        value: modelPlanSelectionValue(plan.id, model.id),
        effect,
        label: model.name.trim() || model.id.trim(),
        modelPlanId: plan.id,
        sourceName: plan.name,
        description: metadata.filter(Boolean).join(" · ")
      };
    });
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
  // Staged plan decisions are always explicit: a plan id, or null for a
  // native selection. Both directions across the plan boundary change the
  // session's endpoint, so leaving a plan (explicit null on a plan session)
  // requires a new session just like switching plans. An absent key means no
  // plan decision was staged at all.
  if (!input.draftSettings || input.draftSettings.modelPlanId === undefined) {
    return false;
  }
  const draftModelPlanID = input.draftSettings.modelPlanId?.trim() ?? "";
  return draftModelPlanID !== (input.activeSettings.modelPlanId?.trim() ?? "");
}
