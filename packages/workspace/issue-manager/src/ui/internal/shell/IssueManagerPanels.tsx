import { useState, type JSX } from "react";
import {
  Badge,
  Button,
  ConfirmationDialog,
  ScrollArea
} from "@tutti-os/ui-system";
import type { IssueManagerIssueSummary } from "../../../contracts/index.ts";
import {
  formatIssueManagerTimestamp,
  resolveIssueManagerStatusLabel
} from "../../../services/controllerModel.ts";
import { issueManagerStatusBadgeVariant } from "../status/IssueManagerStatusBadge.ts";
import {
  IssueManagerLatestRunStatusSection,
  IssueManagerOutputSection,
  IssueManagerSubtaskSection
} from "../issue/IssueManagerIssueSections.tsx";
import {
  resolveIssueManagerIssueAcceptanceTaskId,
  resolveIssueManagerIssueRunTaskId,
  resolveIssueManagerVisibleSubtasks
} from "../issue/IssueManagerIssueAcceptanceState.ts";
import type { IssueManagerLatestRunStatusRenderer } from "../../latestRunStatusRenderer.ts";
import { IssueManagerDescriptionSection } from "../content/IssueManagerDescriptionSection.tsx";
import { IssueManagerTitleTooltip } from "../content/IssueManagerTitleTooltip.tsx";
import { IssueManagerPaneLoadingState } from "../panel/IssueManagerPanelSurface.tsx";
import { resolveIssueManagerCreatorLabel } from "../panel/IssueManagerPanelText.ts";
import { IssueManagerRichTextTextarea } from "../content/IssueManagerRichTextTextarea.tsx";
import { IssueManagerTaskAcceptanceCard } from "../task/IssueManagerTaskAcceptanceCard.tsx";
import type { IssueManagerController } from "../../react/index.ts";
import { IssueManagerDraftTitleInput } from "./IssueManagerDraftTitleInput.tsx";
import {
  issueManagerEditorFooterFadeInClassName,
  issueManagerEditorRiseInClassName,
  issueManagerEditorRiseInDelay0ClassName,
  issueManagerEditorRiseInDelay1ClassName,
  issueManagerEditorRiseInDelay2ClassName
} from "./IssueManagerEditorMotion.ts";
import { IssueManagerExecutionProfileFields } from "../orchestration/IssueManagerOrchestrationFields.tsx";
import { createLowerIntensityBudgetRecoveryPatch } from "../orchestration/IssueManagerBudgetRecovery.ts";

export { IssueManagerEmptyIllustration } from "../panel/IssueManagerPanelSurface.tsx";

export function IssueManagerIssuePane({
  controller,
  renderLatestRunStatus,
  selectedIssue,
  onDismissCreate
}: {
  controller: IssueManagerController;
  renderLatestRunStatus?: IssueManagerLatestRunStatusRenderer;
  selectedIssue: IssueManagerIssueSummary | null;
  onDismissCreate: () => void;
}): JSX.Element {
  const copy = controller.copy;
  const isIssueTitleMissing = controller.issueDraft.title.trim().length === 0;
  const isCreatingIssue = controller.issueEditorMode === "create";
  const isEditingIssue = controller.issueEditorMode === "edit";
  const issueContent = selectedIssue?.content ?? "";
  const tasks = controller.issueDetail.value?.tasks ?? [];
  const selectedTaskId = controller.nodeState.selectedTaskId;
  const issueLatestRun =
    controller.issueDetail.value?.latestRun ??
    controller.issueDetail.value?.recentRuns[0] ??
    null;
  const issueLatestOutputs = controller.issueDetail.value?.latestOutputs ?? [];
  const issueAcceptanceTaskId = resolveIssueManagerIssueAcceptanceTaskId({
    latestRun: issueLatestRun,
    selectedIssue,
    selectedTaskId,
    tasks
  });
  const issueRunTaskId = resolveIssueManagerIssueRunTaskId({
    latestRun: issueLatestRun,
    selectedIssue,
    tasks
  });
  const visibleTasks = resolveIssueManagerVisibleSubtasks({
    hiddenIssueRunTaskId: issueRunTaskId,
    tasks
  });
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  if (isCreatingIssue || isEditingIssue) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <ScrollArea
          scrollbarMode="native"
          className="min-h-0 flex-1 [&_[data-orientation=vertical][data-slot=scroll-area-scrollbar]]:opacity-100 [&_[data-slot=scroll-area-viewport]]:overscroll-contain"
        >
          <div className="flex min-h-full flex-col gap-[14px] px-7 py-8">
            <div className="flex w-full min-w-0 flex-col gap-3">
              <div
                className={`${issueManagerEditorRiseInClassName} ${issueManagerEditorRiseInDelay0ClassName}`}
              >
                <h2 className="m-0 text-[15px] font-semibold leading-[1.35] text-[var(--text-primary)]">
                  {isCreatingIssue
                    ? copy.t("actions.createIssue")
                    : copy.t("actions.editIssue")}
                </h2>
              </div>
              <div className="flex w-full min-w-0 flex-col gap-6">
                <label
                  className={`flex w-full min-w-0 flex-col gap-2 text-[13px] font-semibold text-[var(--text-secondary)] ${issueManagerEditorRiseInClassName} ${issueManagerEditorRiseInDelay1ClassName}`}
                >
                  <span className="leading-5">{copy.t("labels.title")}</span>
                  <IssueManagerDraftTitleInput
                    placeholder={copy.t("composer.issueTitlePlaceholder")}
                    value={controller.issueDraft.title}
                    onChange={controller.setIssueTitle}
                  />
                </label>
                <div
                  className={`flex min-h-0 w-full min-w-0 flex-col gap-2 text-[13px] font-semibold text-[var(--text-secondary)] ${issueManagerEditorRiseInClassName} ${issueManagerEditorRiseInDelay2ClassName}`}
                >
                  <span className="leading-5">{copy.t("labels.content")}</span>
                  <IssueManagerRichTextTextarea
                    controller={controller}
                    surface="issue"
                    textareaClassName="min-h-[180px] resize-none"
                    placeholder={copy.t("composer.issueContentPlaceholder")}
                    value={controller.issueDraft.content}
                    onChange={controller.setIssueContent}
                  />
                </div>
                <IssueManagerExecutionProfileFields controller={controller} />
              </div>
            </div>
          </div>
        </ScrollArea>
        <div
          className={`shrink-0 border-t border-border-1 px-7 py-4 ${issueManagerEditorFooterFadeInClassName}`}
        >
          <div className="flex items-center justify-end gap-3">
            <Button
              size="dialog"
              type="button"
              variant="secondary"
              onClick={onDismissCreate}
            >
              {copy.t("actions.cancel")}
            </Button>
            <Button
              disabled={isIssueTitleMissing}
              size="dialog"
              type="button"
              onClick={() => void controller.saveIssue()}
            >
              {copy.t("actions.saveIssue")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!selectedIssue) {
    return <div className="h-full min-h-0" />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <ScrollArea
        scrollbarMode="native"
        className="min-h-0 flex-1 [&_[data-orientation=vertical][data-slot=scroll-area-scrollbar]]:opacity-100 [&_[data-slot=scroll-area-viewport]]:overscroll-contain"
      >
        <div className="px-8 py-7">
          {controller.issueDetail.isLoading &&
          controller.issueDetail.value === null ? (
            <IssueManagerPaneLoadingState />
          ) : (
            <div className="flex w-full min-w-0 flex-col gap-9">
              <header className="grid gap-3">
                <div className="flex items-center justify-between gap-6">
                  <IssueManagerTitleTooltip title={selectedIssue.title}>
                    <h2 className="line-clamp-2 min-w-0 flex-1 whitespace-normal text-[15px] font-semibold leading-6 text-[var(--text-primary)] [overflow-wrap:anywhere]">
                      {selectedIssue.title}
                    </h2>
                  </IssueManagerTitleTooltip>
                  <div className="flex shrink-0 items-center gap-2">
                    {controller.isTuttiModePlanIssue &&
                    selectedIssue.sourceSessionId &&
                    controller.canOpenAgentSessions ? (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          void controller.openPlanningSession(selectedIssue)
                        }
                      >
                        {copy.t("actions.openPlanningSession")}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => controller.setIssueEditorMode("edit")}
                    >
                      {copy.t("actions.edit")}
                    </Button>
                    <Button
                      className="text-[var(--state-danger)] hover:bg-[var(--on-danger)] hover:text-[var(--state-danger)]"
                      type="button"
                      variant="ghost"
                      onClick={() => setDeleteDialogOpen(true)}
                    >
                      {copy.t("actions.delete")}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[11px] font-normal leading-[1.3] text-[var(--text-secondary)]">
                  <Badge
                    variant={issueManagerStatusBadgeVariant(
                      selectedIssue.status
                    )}
                  >
                    {resolveIssueManagerStatusLabel(copy, selectedIssue.status)}
                  </Badge>
                  <span
                    aria-hidden="true"
                    className="h-4 w-px shrink-0 bg-[var(--line-2)]"
                  />
                  <span className="text-[11px] font-normal leading-[1.3]">
                    {copy.t("labels.creator")}{" "}
                    {resolveIssueManagerCreatorLabel(selectedIssue)}
                  </span>
                  <span
                    aria-hidden="true"
                    className="h-4 w-px shrink-0 bg-[var(--line-2)]"
                  />
                  <span className="text-[11px] font-normal leading-[1.3]">
                    {copy.t("labels.createdAt")}{" "}
                    {formatIssueManagerTimestamp(selectedIssue.createdAtUnix) ||
                      "-"}
                  </span>
                </div>
                {issueAcceptanceTaskId ? (
                  <IssueManagerTaskAcceptanceCard
                    controller={controller}
                    taskId={issueAcceptanceTaskId}
                  />
                ) : null}
              </header>
              <ConfirmationDialog
                cancelLabel={copy.t("actions.cancel")}
                confirmBusy={deleteBusy}
                confirmLabel={copy.t("actions.delete")}
                description={selectedIssue.title}
                open={deleteDialogOpen}
                title={copy.t("confirmations.deleteIssue")}
                tone="destructive"
                onConfirm={() => {
                  setDeleteBusy(true);
                  void controller
                    .deleteIssue({ skipConfirmation: true })
                    .finally(() => {
                      setDeleteBusy(false);
                      setDeleteDialogOpen(false);
                    });
                }}
                onOpenChange={setDeleteDialogOpen}
              />
              <IssueManagerDescriptionSection
                content={issueContent}
                emptyLabel={copy.t("messages.issueContentEmpty")}
                label={copy.t("labels.description")}
                onMentionAction={controller.openMention}
                onOpen={controller.openReference}
                variant="plain"
              />
              {controller.isTuttiModePlanIssue ? (
                <IssueManagerExecutionOverview
                  controller={controller}
                  issue={selectedIssue}
                />
              ) : null}
              <IssueManagerLatestRunStatusSection
                copy={copy}
                latestRun={issueLatestRun}
                onOpenAgentSession={
                  controller.canOpenAgentSessions
                    ? controller.openAgentSession
                    : undefined
                }
                renderLatestRunStatus={renderLatestRunStatus}
                title={selectedIssue.title}
              />
              <IssueManagerOutputSection
                copy={copy}
                outputs={issueLatestOutputs}
                onOpen={controller.openReference}
              />
              <IssueManagerSubtaskSection
                copy={copy}
                diagnostics={controller.diagnostics}
                onCreate={controller.createTaskDraft}
                onMoveTask={controller.moveTask}
                onSelectTask={controller.selectTask}
                selectedTaskId={selectedTaskId}
                showTaskStructure={controller.isTuttiModePlanIssue}
                tasks={visibleTasks}
              />
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function IssueManagerExecutionOverview({
  controller,
  issue
}: {
  controller: IssueManagerController;
  issue: IssueManagerIssueSummary;
}): JSX.Element | null {
  const executionProfile = issue.executionProfile;
  const budget = issue.budget;
  if (!executionProfile || !budget) {
    return null;
  }
  const usagePercent =
    budget.tokenLimit > 0
      ? Math.min(
          100,
          Math.round((budget.consumedTokens / budget.tokenLimit) * 100)
        )
      : 0;
  const openBudgetRecoveryEditor = () => {
    controller.setIssueDraft({
      budget: {
        ...budget,
        mode: "fixed",
        status: "active",
        tokenLimit:
          budget.tokenLimit +
          Math.max(10_000, Math.ceil(budget.tokenLimit * 0.25))
      }
    });
    controller.setIssueEditorMode("edit");
  };
  const lowerIntensityAndContinue = () => {
    controller.setIssueDraft(
      createLowerIntensityBudgetRecoveryPatch({ budget, executionProfile })
    );
    controller.setIssueEditorMode("edit");
  };
  const firstRemainingTask = controller.issueDetail.value?.tasks.find(
    (task) => task.status === "not_started" || task.status === "failed"
  );
  return (
    <section className="grid gap-2.5">
      <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
        {controller.copy.t("labels.executionProfile")}
      </h3>
      <div className="grid gap-2 rounded-[12px] border border-[var(--line-2)] px-4 py-3 text-[12px] text-[var(--text-secondary)] sm:grid-cols-2">
        <span>
          {controller.copy.t("labels.reasoningIntensity")}:{" "}
          {executionProfile.reasoningIntensity}
        </span>
        <span>
          {controller.copy.t("labels.orchestrationIntensity")}:{" "}
          {executionProfile.orchestrationIntensity}
        </span>
        <span>
          {controller.copy.t("labels.tokenUsage")}:{" "}
          {budget.consumedTokens.toLocaleString()} /{" "}
          {budget.tokenLimit > 0 ? budget.tokenLimit.toLocaleString() : "-"} (
          {usagePercent}%)
        </span>
        <span>
          {controller.copy.t("labels.estimatedCost")}:{" "}
          {formatIssueManagerCost(
            issue.cost?.estimatedMicros,
            issue.cost?.currency
          )}
        </span>
        {budget.remainingQuotaPercent !== undefined ? (
          <span>
            {controller.copy.t("labels.remainingQuota")}:{" "}
            {budget.remainingQuotaPercent}%
          </span>
        ) : null}
      </div>
      {budget.status === "soft_limited" ? (
        <div className="grid gap-3 rounded-[12px] border border-[var(--color-warning)] bg-[var(--background-secondary)] px-4 py-3 text-[12px] text-[var(--text-primary)]">
          <p>{controller.copy.t("labels.budgetSoftLimited")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={openBudgetRecoveryEditor}
            >
              {controller.copy.t("actions.addBudget")}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={lowerIntensityAndContinue}
            >
              {controller.copy.t("actions.lowerIntensityAndContinue")}
            </Button>
            <Button
              disabled={!firstRemainingTask}
              size="sm"
              type="button"
              variant="secondary"
              onClick={() =>
                firstRemainingTask &&
                controller.selectTask(firstRemainingTask.taskId)
              }
            >
              {controller.copy.t("actions.continueRemainingTasksManually")}
            </Button>
          </div>
        </div>
      ) : null}
      {issue.dispatchPaused && budget.status !== "soft_limited" ? (
        <div className="grid gap-3 rounded-[12px] border border-[var(--color-warning)] bg-[var(--background-secondary)] px-4 py-3 text-[12px] text-[var(--text-primary)]">
          <p>{controller.copy.t("labels.budgetRecoveryRearrangeHint")}</p>
          <div>
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                controller.setIssueDraft({ dispatchPaused: false });
                controller.setIssueEditorMode("edit");
              }}
            >
              {controller.copy.t("actions.resumeDispatch")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function formatIssueManagerCost(
  micros: number | undefined,
  currency: string | undefined
): string {
  if (!micros) return "-";
  return `${currency || "USD"} ${(micros / 1_000_000).toFixed(4)}`;
}
