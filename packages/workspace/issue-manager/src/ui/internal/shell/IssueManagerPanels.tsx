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
                tasks={visibleTasks}
              />
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
