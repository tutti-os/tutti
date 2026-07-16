import type { TranslateFn } from "../../../i18n/index";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";

type AgentGUITuttiModeLabels = Pick<
  AgentGUIViewLabels,
  | "tuttiModeDescription"
  | "tuttiModeLabel"
  | "tuttiModePlanLoadFailed"
  | "tuttiModePlanPanel"
  | "tuttiModePlanRetry"
  | "tuttiModeUpdateFailed"
  | "tuttiModeUpdateUncertain"
>;

export function agentGUITuttiModeLabels(
  t: TranslateFn
): AgentGUITuttiModeLabels {
  return {
    tuttiModeLabel: t("agentHost.agentGui.tuttiModeLabel"),
    tuttiModeDescription: t("agentHost.agentGui.tuttiModeDescription"),
    tuttiModeUpdateFailed: t("agentHost.agentGui.tuttiModeUpdateFailed"),
    tuttiModeUpdateUncertain: t("agentHost.agentGui.tuttiModeUpdateUncertain"),
    tuttiModePlanPanel: {
      mode: t("agentHost.agentGui.tuttiModePlan.mode"),
      configurationReview: t(
        "agentHost.agentGui.tuttiModePlan.configurationReview"
      ),
      taskReview: t("agentHost.agentGui.tuttiModePlan.taskReview"),
      pending: t("agentHost.agentGui.tuttiModePlan.pending"),
      accept: t("agentHost.agentGui.tuttiModePlan.accept"),
      requestChanges: t("agentHost.agentGui.tuttiModePlan.requestChanges"),
      cancel: t("agentHost.agentGui.tuttiModePlan.cancel"),
      feedbackPlaceholder: t(
        "agentHost.agentGui.tuttiModePlan.feedbackPlaceholder"
      ),
      submitFeedback: t("agentHost.agentGui.tuttiModePlan.submitFeedback"),
      feedbackRequired: t("agentHost.agentGui.tuttiModePlan.feedbackRequired"),
      tasks: t("agentHost.agentGui.tuttiModePlan.tasks"),
      execution: t("agentHost.agentGui.tuttiModePlan.execution"),
      executionSequential: t(
        "agentHost.agentGui.tuttiModePlan.executionSequential"
      ),
      executionParallel: t(
        "agentHost.agentGui.tuttiModePlan.executionParallel"
      ),
      budget: t("agentHost.agentGui.tuttiModePlan.budget"),
      budgetAuto: t("agentHost.agentGui.tuttiModePlan.budgetAuto"),
      budgetFixed: t("agentHost.agentGui.tuttiModePlan.budgetFixed"),
      reasoningIntensity: t(
        "agentHost.agentGui.tuttiModePlan.reasoningIntensity"
      ),
      orchestrationIntensity: t(
        "agentHost.agentGui.tuttiModePlan.orchestrationIntensity"
      ),
      tokenLimit: t("agentHost.agentGui.tuttiModePlan.tokenLimit"),
      quotaWaterline: t("agentHost.agentGui.tuttiModePlan.quotaWaterline"),
      taskId: t("agentHost.agentGui.tuttiModePlan.taskId"),
      priority: t("agentHost.agentGui.tuttiModePlan.priority"),
      priorityHigh: t("agentHost.agentGui.tuttiModePlan.priorityHigh"),
      priorityMedium: t("agentHost.agentGui.tuttiModePlan.priorityMedium"),
      priorityLow: t("agentHost.agentGui.tuttiModePlan.priorityLow"),
      agentTarget: t("agentHost.agentGui.tuttiModePlan.agentTarget"),
      modelPlan: t("agentHost.agentGui.tuttiModePlan.modelPlan"),
      model: t("agentHost.agentGui.tuttiModePlan.model"),
      executionDirectory: t(
        "agentHost.agentGui.tuttiModePlan.executionDirectory"
      ),
      dependencies: t("agentHost.agentGui.tuttiModePlan.dependencies"),
      notSpecified: t("agentHost.agentGui.tuttiModePlan.notSpecified"),
      none: t("agentHost.agentGui.tuttiModePlan.none")
    },
    tuttiModePlanLoadFailed: t("agentHost.agentGui.tuttiModePlan.loadFailed"),
    tuttiModePlanRetry: t("agentHost.agentGui.tuttiModePlan.retry")
  };
}
