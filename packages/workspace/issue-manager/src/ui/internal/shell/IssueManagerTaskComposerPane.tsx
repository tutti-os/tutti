import type { JSX } from "react";
import { Button } from "@tutti-os/ui-system";
import type { IssueManagerIssueSummary } from "../../../contracts/index.ts";
import { IssueManagerRichTextTextarea } from "../content/IssueManagerRichTextTextarea.tsx";
import type { IssueManagerController } from "../../react/index.ts";
import { IssueManagerDraftTitleInput } from "./IssueManagerDraftTitleInput.tsx";
import {
  issueManagerEditorFooterFadeInClassName,
  issueManagerEditorRiseInClassName,
  issueManagerEditorRiseInDelay0ClassName,
  issueManagerEditorRiseInDelay1ClassName,
  issueManagerEditorRiseInDelay2ClassName
} from "./IssueManagerEditorMotion.ts";
import { IssueManagerTaskAssignmentFields } from "../orchestration/IssueManagerOrchestrationFields.tsx";

export function IssueManagerTaskComposerPane({
  controller,
  onCancel,
  selectedIssue
}: {
  controller: IssueManagerController;
  onCancel: () => void;
  selectedIssue: IssueManagerIssueSummary | null;
}): JSX.Element {
  const copy = controller.copy;
  const isTaskTitleMissing = controller.taskDraft.title.trim().length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-y-auto px-7 py-8">
        <div className="flex w-full min-w-0 flex-col gap-3">
          <div
            className={`${issueManagerEditorRiseInClassName} ${issueManagerEditorRiseInDelay0ClassName}`}
          >
            <h2 className="m-0 text-[15px] font-semibold leading-[1.35] text-[var(--text-primary)]">
              {copy.t("actions.addSubtask")}
            </h2>
          </div>
          <div className="flex w-full min-w-0 flex-col gap-6">
            <label
              className={`flex w-full min-w-0 flex-col gap-2 text-[13px] font-semibold text-[var(--text-secondary)] ${issueManagerEditorRiseInClassName} ${issueManagerEditorRiseInDelay1ClassName}`}
            >
              <span className="leading-5">{copy.t("labels.title")}</span>
              <IssueManagerDraftTitleInput
                placeholder={copy.t("composer.subtaskTitlePlaceholder")}
                value={controller.taskDraft.title}
                onChange={controller.setTaskTitle}
              />
            </label>
            <div
              className={`flex min-h-0 w-full min-w-0 flex-col gap-2 text-[13px] font-semibold text-[var(--text-secondary)] ${issueManagerEditorRiseInClassName} ${issueManagerEditorRiseInDelay2ClassName}`}
            >
              <span className="leading-5">
                {copy.t("labels.requirementDescription")}
              </span>
              <IssueManagerRichTextTextarea
                controller={controller}
                surface="task"
                textareaClassName="min-h-[180px] resize-none"
                placeholder={copy.t("composer.subtaskContentPlaceholder")}
                value={controller.taskDraft.content}
                onChange={controller.setTaskContent}
              />
            </div>
            <IssueManagerTaskAssignmentFields controller={controller} />
          </div>
        </div>
      </div>

      <div
        className={`shrink-0 border-t border-border-1 px-7 py-4 ${issueManagerEditorFooterFadeInClassName}`}
      >
        <div className="flex items-center justify-end gap-3">
          <Button
            size="default"
            type="button"
            variant="secondary"
            onClick={onCancel}
          >
            {copy.t("actions.cancel")}
          </Button>
          <Button
            disabled={!selectedIssue || isTaskTitleMissing}
            size="default"
            type="button"
            onClick={() => void controller.saveTask()}
          >
            {copy.t("actions.saveSubtask")}
          </Button>
        </div>
      </div>
    </div>
  );
}
