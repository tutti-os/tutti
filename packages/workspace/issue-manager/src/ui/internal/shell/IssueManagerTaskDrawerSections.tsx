import { useState, type JSX } from "react";
import {
  Badge,
  BareIconButton,
  Button,
  CollapseLinedIcon,
  ConfirmationDialog
} from "@tutti-os/ui-system";
import type {
  IssueManagerIssueSummary,
  IssueManagerTaskSummary
} from "../../../contracts/index.ts";
import {
  formatIssueManagerTimestamp,
  resolveIssueManagerStatusLabel
} from "../../../services/controllerModel.ts";
import { IssueManagerDescriptionSection } from "../content/IssueManagerDescriptionSection.tsx";
import { IssueManagerTitleTooltip } from "../content/IssueManagerTitleTooltip.tsx";
import {
  IssueManagerLatestRunStatusSection,
  IssueManagerOutputSection
} from "../issue/IssueManagerIssueSections.tsx";
import type { IssueManagerLatestRunStatusRenderer } from "../../latestRunStatusRenderer.ts";
import { IssueManagerTaskDrawerLoadingState } from "../panel/IssueManagerPanelSurface.tsx";
import { resolveTaskCreatorLabel } from "../panel/IssueManagerPanelText.ts";
import { IssueManagerRichTextTextarea } from "../content/IssueManagerRichTextTextarea.tsx";
import {
  IssueManagerExecutionDirectoryTrigger,
  IssueManagerRunActionTrigger
} from "../task/IssueManagerRunSections.tsx";
import { IssueManagerTaskAcceptanceCard } from "../task/IssueManagerTaskAcceptanceCard.tsx";
import { issueManagerStatusBadgeVariant } from "../status/IssueManagerStatusBadge.ts";
import { IssueManagerDraftTitleInput } from "./IssueManagerDraftTitleInput.tsx";
import {
  canIssueManagerSaveTask,
  isIssueManagerRunControlDisabled,
  type IssueManagerTaskDrawerViewState
} from "./IssueManagerTaskDrawerState.ts";
import type { IssueManagerController } from "../../react/index.ts";
import {
  issueManagerEditorFooterFadeInClassName,
  issueManagerEditorRiseInClassName,
  issueManagerEditorRiseInDelay0ClassName,
  issueManagerEditorRiseInDelay1ClassName,
  issueManagerEditorRiseInDelay2ClassName
} from "./IssueManagerEditorMotion.ts";
import { IssueManagerTaskAssignmentFields } from "../orchestration/IssueManagerOrchestrationFields.tsx";

export function IssueManagerTaskDrawerHeader({
  controller,
  onClose,
  selectedTask,
  view
}: {
  controller: IssueManagerController;
  onClose: () => void;
  selectedTask: IssueManagerTaskSummary | null;
  view: Pick<
    IssueManagerTaskDrawerViewState,
    "showTaskActions" | "showTaskMetadata" | "title"
  >;
}): JSX.Element {
  const copy = controller.copy;
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  return (
    <>
      <div className="grid gap-3 px-6 pt-7 pb-3">
        <div className="flex items-center justify-between gap-6">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BareIconButton
              aria-label={copy.t("actions.closeTaskDetails")}
              size="md"
              title={copy.t("actions.closeTaskDetails")}
              onClick={onClose}
            >
              <CollapseLinedIcon className="size-4" />
            </BareIconButton>
            {view.showTaskMetadata && selectedTask ? (
              <IssueManagerTitleTooltip title={view.title}>
                <h3 className="line-clamp-2 min-w-0 flex-1 whitespace-normal text-[15px] font-semibold leading-6 text-[var(--text-primary)] [overflow-wrap:anywhere]">
                  {view.title}
                </h3>
              </IssueManagerTitleTooltip>
            ) : (
              <IssueManagerTitleTooltip title={view.title}>
                <h3 className="line-clamp-2 min-w-0 flex-1 whitespace-normal text-[15px] font-semibold leading-[1.35] text-[var(--text-primary)] [overflow-wrap:anywhere]">
                  {view.title}
                </h3>
              </IssueManagerTitleTooltip>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {view.showTaskActions && selectedTask ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => controller.setTaskEditorMode("edit")}
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
              </>
            ) : null}
          </div>
        </div>
        {view.showTaskMetadata && selectedTask ? (
          <div className="grid gap-2">
            <IssueManagerTaskMetadataRow
              copy={copy}
              selectedTask={selectedTask}
            />
            {selectedTask.status === "pending_acceptance" ? (
              <IssueManagerTaskAcceptanceCard controller={controller} />
            ) : null}
          </div>
        ) : null}
      </div>
      {selectedTask ? (
        <ConfirmationDialog
          cancelLabel={copy.t("actions.cancel")}
          confirmBusy={deleteBusy}
          confirmLabel={copy.t("actions.delete")}
          description={
            <span className="block max-w-full whitespace-normal [overflow-wrap:anywhere]">
              {selectedTask.title}
            </span>
          }
          open={deleteDialogOpen}
          title={copy.t("confirmations.deleteTask")}
          tone="destructive"
          onConfirm={() => {
            setDeleteBusy(true);
            void controller
              .deleteTask({ skipConfirmation: true })
              .finally(() => {
                setDeleteBusy(false);
                setDeleteDialogOpen(false);
              });
          }}
          onOpenChange={setDeleteDialogOpen}
        />
      ) : null}
    </>
  );
}

function IssueManagerTaskMetadataRow({
  copy,
  selectedTask
}: {
  copy: IssueManagerController["copy"];
  selectedTask: IssueManagerTaskSummary;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[11px] font-normal leading-[1.3] text-[var(--text-secondary)]">
      <Badge variant={issueManagerStatusBadgeVariant(selectedTask.status)}>
        {resolveIssueManagerStatusLabel(copy, selectedTask.status)}
      </Badge>
      <span
        aria-hidden="true"
        className="h-4 w-px shrink-0 bg-[var(--line-2)]"
      />
      <span className="text-[11px] font-normal leading-[1.3]">
        {copy.t("labels.creator")} {resolveTaskCreatorLabel(selectedTask)}
      </span>
      <span
        aria-hidden="true"
        className="h-4 w-px shrink-0 bg-[var(--line-2)]"
      />
      <span className="text-[11px] font-normal leading-[1.3]">
        {copy.t("labels.createdAt")}{" "}
        {formatIssueManagerTimestamp(selectedTask.createdAtUnix) || "-"}
      </span>
    </div>
  );
}

export function IssueManagerTaskDrawerLoadingBody(): JSX.Element {
  return <IssueManagerTaskDrawerLoadingState />;
}

export function IssueManagerTaskDrawerBody({
  controller,
  renderLatestRunStatus,
  taskContent,
  view
}: {
  controller: IssueManagerController;
  renderLatestRunStatus?: IssueManagerLatestRunStatusRenderer;
  taskContent: string;
  view: Pick<
    IssueManagerTaskDrawerViewState,
    "bodyKind" | "isCreate" | "title"
  >;
}): JSX.Element {
  if (view.bodyKind === "loading") {
    return <IssueManagerTaskDrawerLoadingBody />;
  }

  if (view.bodyKind === "edit") {
    return (
      <IssueManagerTaskDrawerEditBody
        controller={controller}
        title={view.title}
      />
    );
  }

  return (
    <IssueManagerTaskDrawerReadBody
      controller={controller}
      latestRunTitle={view.title}
      renderLatestRunStatus={renderLatestRunStatus}
      taskContent={taskContent}
    />
  );
}

export function IssueManagerTaskDrawerEditBody({
  controller,
  title
}: {
  controller: IssueManagerController;
  title: string;
}): JSX.Element {
  const copy = controller.copy;

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <div
        className={`${issueManagerEditorRiseInClassName} ${issueManagerEditorRiseInDelay0ClassName}`}
      >
        <h2 className="m-0 text-[15px] font-semibold leading-[1.35] text-[var(--text-primary)]">
          {title}
        </h2>
      </div>
      <div className="flex w-full min-w-0 flex-col gap-6">
        <label
          className={`flex w-full min-w-0 flex-col gap-2 text-[13px] font-semibold text-[var(--text-secondary)] ${issueManagerEditorRiseInClassName} ${issueManagerEditorRiseInDelay1ClassName}`}
        >
          <span className="leading-5">{copy.t("labels.title")}</span>
          <IssueManagerDraftTitleInput
            placeholder={copy.t("composer.taskTitlePlaceholder")}
            value={controller.taskDraft.title}
            onChange={controller.setTaskTitle}
          />
        </label>
        <div
          className={`flex min-h-0 w-full min-w-0 flex-col gap-2 text-[13px] font-semibold text-[var(--text-secondary)] ${issueManagerEditorRiseInClassName} ${issueManagerEditorRiseInDelay2ClassName}`}
        >
          <span className="leading-5">{copy.t("labels.content")}</span>
          <IssueManagerRichTextTextarea
            controller={controller}
            surface="task"
            textareaClassName="min-h-[180px] resize-none"
            placeholder={copy.t("composer.taskContentPlaceholder")}
            value={controller.taskDraft.content}
            onChange={controller.setTaskContent}
          />
        </div>
        <IssueManagerTaskAssignmentFields controller={controller} />
      </div>
    </div>
  );
}

export function IssueManagerTaskDrawerReadBody({
  controller,
  latestRunTitle,
  renderLatestRunStatus,
  taskContent
}: {
  controller: IssueManagerController;
  latestRunTitle: string;
  renderLatestRunStatus?: IssueManagerLatestRunStatusRenderer;
  taskContent: string;
}): JSX.Element {
  const copy = controller.copy;
  const latestRun =
    controller.taskDetail.value?.latestRun ??
    controller.taskDetail.value?.recentRuns[0] ??
    null;
  const latestOutputs = controller.taskDetail.value?.latestOutputs ?? [];

  return (
    <>
      <IssueManagerDescriptionSection
        content={taskContent}
        emptyLabel={copy.t("messages.taskContentEmpty")}
        label={copy.t("labels.description")}
        onMentionAction={controller.openMention}
        onOpen={controller.openReference}
        variant="plain"
      />
      <IssueManagerLatestRunStatusSection
        copy={copy}
        latestRun={latestRun}
        onOpenAgentSession={
          controller.canOpenAgentSessions
            ? controller.openAgentSession
            : undefined
        }
        renderLatestRunStatus={renderLatestRunStatus}
        title={latestRunTitle}
      />
      <IssueManagerOutputSection
        copy={copy}
        outputs={latestOutputs}
        onOpen={controller.openReference}
      />
    </>
  );
}

export function IssueManagerTaskDrawerFooter({
  controller,
  selectedIssue,
  selectedTask,
  view
}: {
  controller: IssueManagerController;
  selectedIssue: IssueManagerIssueSummary | null;
  selectedTask: IssueManagerTaskSummary | null;
  view: Pick<
    IssueManagerTaskDrawerViewState,
    | "isCreate"
    | "isEdit"
    | "showEditFooter"
    | "showReadFooter"
    | "isTaskTitleMissing"
  >;
}): JSX.Element | null {
  const copy = controller.copy;
  const runControlsDisabled = isIssueManagerRunControlDisabled({
    selectedIssueStatus: selectedIssue?.status,
    selectedTaskStatus: selectedTask?.status
  });

  if (view.showReadFooter && selectedTask) {
    return (
      <div className="border-t border-[var(--border-1)] bg-transparent px-6 py-4 backdrop-blur">
        <div className="flex items-center justify-end gap-3">
          <IssueManagerExecutionDirectoryTrigger
            className="mr-auto"
            controller={controller}
            disabled={runControlsDisabled}
          />
          <IssueManagerRunActionTrigger
            controller={controller}
            disabled={runControlsDisabled}
            triggerVariant="button"
          />
          {controller.canInviteCollaborators ? (
            <Button
              disabled={!selectedIssue}
              size="dialog"
              type="button"
              onClick={() => {
                void controller.shareSelection();
              }}
            >
              {copy.t("actions.inviteCollaborator")}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (view.showEditFooter) {
    return (
      <div
        className={`border-t border-border-1 px-6 py-4 ${issueManagerEditorFooterFadeInClassName}`}
      >
        <div className="flex items-center justify-end gap-3">
          <Button
            size="dialog"
            type="button"
            variant="secondary"
            onClick={() => controller.setTaskEditorMode("read")}
          >
            {copy.t("actions.cancel")}
          </Button>
          <Button
            disabled={
              canIssueManagerSaveTask({
                selectedIssue,
                view
              }) === false
            }
            size="dialog"
            type="button"
            onClick={() => void controller.saveTask()}
          >
            {copy.t("actions.saveTask")}
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
