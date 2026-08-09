import type { TranslateFn } from "../../../i18n/index";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";

type AgentGUITuttiModeLabels = Pick<
  AgentGUIViewLabels,
  | "tuttiBudgetEffectLabel"
  | "tuttiBudgetSpeedLabel"
  | "tuttiBudgetModelPreferenceBalance"
  | "tuttiBudgetModelPreferenceCost"
  | "tuttiBudgetModelPreferenceLabel"
  | "tuttiBudgetModelPreferencePowerful"
  | "tuttiBudgetPreviewBalance"
  | "tuttiBudgetPreviewCost"
  | "tuttiBudgetPreviewHint"
  | "tuttiBudgetPreviewPowerful"
  | "tuttiBudgetTitle"
  | "tuttiBudgetParallelismLabel"
  | "tuttiBudgetParallelismValue"
  | "tuttiModeDescription"
  | "tuttiModeLabel"
  | "tuttiModeRemove"
  | "tuttiWorkflowDock"
  | "tuttiModePlanIssueCreateFailed"
  | "tuttiModePlanIssueAcceptPrompt"
  | "tuttiModePlanIssuePanel"
  | "tuttiModePlanIssueReworkPrompt"
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
    tuttiBudgetEffectLabel: t("agentHost.agentGui.tuttiBudgetEffectLabel"),
    tuttiBudgetSpeedLabel: t("agentHost.agentGui.tuttiBudgetSpeedLabel"),
    tuttiBudgetPreviewHint: t("agentHost.agentGui.tuttiBudgetPreviewHint"),
    tuttiBudgetPreviewCost: t("agentHost.agentGui.tuttiBudgetPreviewCost"),
    tuttiBudgetPreviewBalance: t(
      "agentHost.agentGui.tuttiBudgetPreviewBalance"
    ),
    tuttiBudgetPreviewPowerful: t(
      "agentHost.agentGui.tuttiBudgetPreviewPowerful"
    ),
    tuttiBudgetModelPreferenceLabel: t(
      "agentHost.agentGui.tuttiBudgetModelPreferenceLabel"
    ),
    tuttiBudgetModelPreferenceCost: t(
      "agentHost.agentGui.tuttiBudgetModelPreferenceCost"
    ),
    tuttiBudgetModelPreferenceBalance: t(
      "agentHost.agentGui.tuttiBudgetModelPreferenceBalance"
    ),
    tuttiBudgetModelPreferencePowerful: t(
      "agentHost.agentGui.tuttiBudgetModelPreferencePowerful"
    ),
    tuttiBudgetParallelismLabel: t(
      "agentHost.agentGui.tuttiBudgetParallelismLabel"
    ),
    tuttiBudgetParallelismValue: (count) =>
      t("agentHost.agentGui.tuttiBudgetParallelismValue", { count }),
    tuttiModeUpdateFailed: t("agentHost.agentGui.tuttiModeUpdateFailed"),
    tuttiModeUpdateUncertain: t("agentHost.agentGui.tuttiModeUpdateUncertain"),
    tuttiModePlanPanel: {
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
    tuttiWorkflowDock: {
      reviewTitle: t("agentHost.agentGui.tuttiModePlan.taskReview"),
      reviewHint: t("agentHost.agentGui.tuttiModePlan.reviewHint"),
      reviewHintReplan: t("agentHost.agentGui.tuttiModePlan.reviewHintReplan"),
      materializingTitle: t(
        "agentHost.agentGui.tuttiModePlan.materializingTitle"
      ),
      materializingHint: t(
        "agentHost.agentGui.tuttiModePlan.materializingHint"
      ),
      errorTitle: t("agentHost.agentGui.tuttiModePlan.errorTitle"),
      expand: t("agentHost.agentGui.tuttiModePlan.expand"),
      collapse: t("agentHost.agentGui.tuttiModePlan.collapse"),
      cancel: t("agentHost.agentGui.tuttiModePlan.cancel"),
      retry: t("agentHost.agentGui.tuttiModePlan.retry"),
      switchToSelfReview: t(
        "agentHost.agentGui.tuttiModePlan.switchToSelfReview"
      ),
      switchingToSelfReview: t(
        "agentHost.agentGui.tuttiModePlan.switchingToSelfReview"
      ),
      selfReviewEnabled: t(
        "agentHost.agentGui.tuttiModePlan.selfReviewEnabled"
      ),
      selfReviewFailed: t("agentHost.agentGui.tuttiModePlan.selfReviewFailed"),
      issueRunning: (count) =>
        t("agentHost.agentGui.tuttiModePlan.issueStripRunning", { count }),
      issuePendingAcceptance: (count) =>
        t("agentHost.agentGui.tuttiModePlan.issueStripPending", { count }),
      issueFailed: (count) =>
        t("agentHost.agentGui.tuttiModePlan.issueStripFailed", { count }),
      issueDone: (done, total) =>
        t("agentHost.agentGui.tuttiModePlan.issueStripDone", { done, total })
    },
    tuttiModePlanSendAccept: t("agentHost.agentGui.tuttiModePlan.sendAccept"),
    tuttiModePlanSendRequestChanges: t(
      "agentHost.agentGui.tuttiModePlan.sendRequestChanges"
    ),
    tuttiModePlanReplanFeedback: (fromEffect, fromSpeed, toEffect, toSpeed) =>
      t("agentHost.agentGui.tuttiModePlan.replanFeedback", {
        fromEffect,
        fromSpeed,
        toEffect,
        toSpeed
      }),
    tuttiModePlanReplanFeedbackSuffix: (effect, speed) =>
      t("agentHost.agentGui.tuttiModePlan.replanFeedbackSuffix", {
        effect,
        speed
      }),
    tuttiModePlanIssuePanel: {
      openIssue: t("agentHost.agentGui.tuttiModePlan.issueOpen"),
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
    tuttiModePlanIssueAcceptPrompt: (reference) =>
      t("agentHost.agentGui.tuttiModePlan.issueAcceptPrompt", { reference }),
    tuttiModePlanIssueReworkPrompt: (reference) =>
      t("agentHost.agentGui.tuttiModePlan.issueReworkPrompt", { reference }),
    tuttiModePlanLoadFailed: t("agentHost.agentGui.tuttiModePlan.loadFailed"),
    tuttiModePlanRetry: t("agentHost.agentGui.tuttiModePlan.retry"),
    tuttiModePlanIssueCreateFailed: (message) =>
      t("agentHost.agentGui.tuttiModePlan.issueCreateFailed", { message })
  };
}
