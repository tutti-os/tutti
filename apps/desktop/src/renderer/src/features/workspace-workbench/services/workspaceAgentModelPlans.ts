import type {
  WorkspaceModelPlan,
  WorkspaceModelPlanProtocol
} from "./workspaceSettingsTypes";

/**
 * Model plans one Agent Runtime can consume. Compatibility is decided by
 * wire protocol alone, so every template kind — official subscriptions,
 * coding plans, domestic providers, relays, and custom endpoints — is
 * selectable as long as its protocol matches the runtime.
 *
 * Disabled plans stay hidden unless they are the draft's current selection,
 * which keeps an existing reference repairable. A null protocol means the
 * runtime cannot consume plans; only the current selection is retained.
 */
export function workspaceAgentCompatibleModelPlans(
  plans: readonly WorkspaceModelPlan[],
  protocol: WorkspaceModelPlanProtocol | null,
  selectedPlanID: string
): readonly WorkspaceModelPlan[] {
  return plans.filter(
    (plan) =>
      (protocol === null
        ? plan.id === selectedPlanID
        : plan.protocol === protocol) &&
      (plan.enabled || plan.id === selectedPlanID)
  );
}
