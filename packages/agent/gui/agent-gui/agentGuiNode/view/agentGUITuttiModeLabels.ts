import type { TranslateFn } from "../../../i18n/index";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";

type AgentGUITuttiModeLabels = Pick<
  AgentGUIViewLabels,
  | "tuttiBudgetAgentCountBalance"
  | "tuttiBudgetAgentCountCost"
  | "tuttiBudgetAgentCountLabel"
  | "tuttiBudgetAgentCountPowerful"
  | "tuttiBudgetCancel"
  | "tuttiBudgetConfirm"
  | "tuttiBudgetIntensityLabel"
  | "tuttiBudgetIntensityMax"
  | "tuttiBudgetIntensityMin"
  | "tuttiBudgetModelStrengthBalance"
  | "tuttiBudgetModelStrengthCost"
  | "tuttiBudgetModelStrengthLabel"
  | "tuttiBudgetModelStrengthPowerful"
  | "tuttiBudgetPreviewBalance"
  | "tuttiBudgetPreviewCost"
  | "tuttiBudgetPreviewHint"
  | "tuttiBudgetPreviewPowerful"
  | "tuttiBudgetPreviewTitle"
  | "tuttiBudgetTitle"
  | "tuttiModeDescription"
  | "tuttiModeLabel"
  | "tuttiModeRemove"
  | "tuttiModePlanBanner"
  | "tuttiModePlanIssueCreateFailed"
  | "tuttiModePlanIssuePanel"
  | "tuttiModePlanIssueStrip"
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
    tuttiModeRemove: t("agentHost.agentGui.tuttiModeRemove"),
    tuttiBudgetTitle: t("agentHost.agentGui.tuttiBudgetTitle"),
    tuttiBudgetIntensityLabel: t(
      "agentHost.agentGui.tuttiBudgetIntensityLabel"
    ),
    tuttiBudgetIntensityMin: t("agentHost.agentGui.tuttiBudgetIntensityMin"),
    tuttiBudgetIntensityMax: t("agentHost.agentGui.tuttiBudgetIntensityMax"),
    tuttiBudgetPreviewTitle: t("agentHost.agentGui.tuttiBudgetPreviewTitle"),
    tuttiBudgetPreviewHint: t("agentHost.agentGui.tuttiBudgetPreviewHint"),
    tuttiBudgetPreviewCost: t("agentHost.agentGui.tuttiBudgetPreviewCost"),
    tuttiBudgetPreviewBalance: t(
      "agentHost.agentGui.tuttiBudgetPreviewBalance"
    ),
    tuttiBudgetPreviewPowerful: t(
      "agentHost.agentGui.tuttiBudgetPreviewPowerful"
    ),
    tuttiBudgetModelStrengthLabel: t(
      "agentHost.agentGui.tuttiBudgetModelStrengthLabel"
    ),
    tuttiBudgetModelStrengthCost: t(
      "agentHost.agentGui.tuttiBudgetModelStrengthCost"
    ),
    tuttiBudgetModelStrengthBalance: t(
      "agentHost.agentGui.tuttiBudgetModelStrengthBalance"
    ),
    tuttiBudgetModelStrengthPowerful: t(
      "agentHost.agentGui.tuttiBudgetModelStrengthPowerful"
    ),
    tuttiBudgetAgentCountLabel: t(
      "agentHost.agentGui.tuttiBudgetAgentCountLabel"
    ),
    tuttiBudgetAgentCountCost: t(
      "agentHost.agentGui.tuttiBudgetAgentCountCost"
    ),
    tuttiBudgetAgentCountBalance: t(
      "agentHost.agentGui.tuttiBudgetAgentCountBalance"
    ),
    tuttiBudgetAgentCountPowerful: t(
      "agentHost.agentGui.tuttiBudgetAgentCountPowerful"
    ),
    tuttiBudgetConfirm: t("agentHost.agentGui.tuttiBudgetConfirm"),
    tuttiBudgetCancel: t("agentHost.agentGui.tuttiBudgetCancel"),
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
      autoAccept: t("agentHost.agentGui.tuttiModePlan.autoAccept"),
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
    tuttiModePlanIssuePanel: {
      openIssue: t("agentHost.agentGui.tuttiModePlan.issueOpen"),
      stopExecution: t("agentHost.agentGui.tuttiModePlan.issueStopExecution"),
      listView: t("agentHost.agentGui.tuttiModePlan.issueListView"),
      boardView: t("agentHost.agentGui.tuttiModePlan.issueBoardView"),
      parallelizable: t("agentHost.agentGui.tuttiModePlan.parallelizable"),
      autoAccept: t("agentHost.agentGui.tuttiModePlan.autoAccept"),
      accept: t("agentHost.agentGui.tuttiModePlan.issueAccept"),
      rework: t("agentHost.agentGui.tuttiModePlan.issueRework"),
      dependencies: t("agentHost.agentGui.tuttiModePlan.issueDependencies"),
      stageParallel: (index, count) =>
        t("agentHost.agentGui.tuttiModePlan.issueStageParallel", {
          count,
          index
        }),
      stageSequential: (index) =>
        t("agentHost.agentGui.tuttiModePlan.issueStageSequential", { index }),
      summary: (done, total, running) =>
        t("agentHost.agentGui.tuttiModePlan.issueSummary", {
          done,
          running,
          total
        }),
      statusNotStarted: t(
        "agentHost.agentGui.tuttiModePlan.issueStatusNotStarted"
      ),
      statusRunning: t("agentHost.agentGui.tuttiModePlan.issueStatusRunning"),
      statusPendingAcceptance: t(
        "agentHost.agentGui.tuttiModePlan.issueStatusPendingAcceptance"
      ),
      statusCompleted: t(
        "agentHost.agentGui.tuttiModePlan.issueStatusCompleted"
      ),
      statusFailed: t("agentHost.agentGui.tuttiModePlan.issueStatusFailed"),
      statusCanceled: t("agentHost.agentGui.tuttiModePlan.issueStatusCanceled")
    },
    tuttiModePlanIssueStrip: {
      running: (count) =>
        t("agentHost.agentGui.tuttiModePlan.issueStripRunning", { count }),
      pendingAcceptance: (count) =>
        t("agentHost.agentGui.tuttiModePlan.issueStripPending", { count }),
      failed: (count) =>
        t("agentHost.agentGui.tuttiModePlan.issueStripFailed", { count }),
      done: (done, total) =>
        t("agentHost.agentGui.tuttiModePlan.issueStripDone", { done, total }),
      jump: t("agentHost.agentGui.tuttiModePlan.issueStripJump")
    },
    tuttiModePlanLoadFailed: t("agentHost.agentGui.tuttiModePlan.loadFailed"),
    tuttiModePlanRetry: t("agentHost.agentGui.tuttiModePlan.retry"),
    tuttiModePlanIssueCreateFailed: (message) =>
      t("agentHost.agentGui.tuttiModePlan.issueCreateFailed", { message })
  };
}
