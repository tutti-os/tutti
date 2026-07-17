import type { TranslateFn } from "../../../i18n/index";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";

type AgentGUITuttiModeLabels = Pick<
  AgentGUIViewLabels,
  | "tuttiModeDescription"
  | "tuttiModeLabel"
  | "tuttiModePlanBanner"
  | "tuttiModePlanLoadFailed"
  | "tuttiModePlanPanel"
  | "tuttiModePlanRetry"
  | "tuttiModePlanReplanFeedback"
  | "tuttiModePlanReplanFeedbackSuffix"
  | "tuttiModePlanSendAccept"
  | "tuttiModePlanSendRequestChanges"
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
      taskReview: t("agentHost.agentGui.tuttiModePlan.taskReview"),
      pending: t("agentHost.agentGui.tuttiModePlan.pending"),
      tasks: t("agentHost.agentGui.tuttiModePlan.tasks"),
      priority: t("agentHost.agentGui.tuttiModePlan.priority"),
      priorityHigh: t("agentHost.agentGui.tuttiModePlan.priorityHigh"),
      priorityMedium: t("agentHost.agentGui.tuttiModePlan.priorityMedium"),
      priorityLow: t("agentHost.agentGui.tuttiModePlan.priorityLow"),
      agentTarget: t("agentHost.agentGui.tuttiModePlan.agentTarget"),
      model: t("agentHost.agentGui.tuttiModePlan.model"),
      permissionMode: t("agentHost.agentGui.tuttiModePlan.permissionMode"),
      reasoningEffort: t("agentHost.agentGui.tuttiModePlan.reasoningEffort"),
      parallelizable: t("agentHost.agentGui.tuttiModePlan.parallelizable"),
      assignmentOptionsLoading: t(
        "agentHost.agentGui.tuttiModePlan.assignmentOptionsLoading"
      ),
      notSpecified: t("agentHost.agentGui.tuttiModePlan.notSpecified")
    },
    tuttiModePlanBanner: {
      title: t("agentHost.agentGui.tuttiModePlan.taskReview"),
      hint: t("agentHost.agentGui.tuttiModePlan.reviewHint"),
      hintReplan: t("agentHost.agentGui.tuttiModePlan.reviewHintReplan"),
      cancel: t("agentHost.agentGui.tuttiModePlan.cancel")
    },
    tuttiModePlanSendAccept: t("agentHost.agentGui.tuttiModePlan.sendAccept"),
    tuttiModePlanSendRequestChanges: t(
      "agentHost.agentGui.tuttiModePlan.sendRequestChanges"
    ),
    tuttiModePlanReplanFeedback: (from, to) =>
      t("agentHost.agentGui.tuttiModePlan.replanFeedback", { from, to }),
    tuttiModePlanReplanFeedbackSuffix: (to) =>
      t("agentHost.agentGui.tuttiModePlan.replanFeedbackSuffix", { to }),
    tuttiModePlanLoadFailed: t("agentHost.agentGui.tuttiModePlan.loadFailed"),
    tuttiModePlanRetry: t("agentHost.agentGui.tuttiModePlan.retry")
  };
}
