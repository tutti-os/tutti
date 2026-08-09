import type {
  IssueManagerContextRef,
  IssueManagerIssueSummary,
  IssueManagerStatus,
  IssueManagerTaskSummary
} from "../../../contracts/index.ts";
import type { IssueManagerController } from "../../react/index.ts";

export interface IssueManagerTaskDrawerViewState {
  bodyKind: "edit" | "loading" | "read";
  isCreate: boolean;
  isEdit: boolean;
  isRead: boolean;
  isTaskTitleMissing: boolean;
  showEditFooter: boolean;
  showReadFooter: boolean;
  showTaskActions: boolean;
  showTaskMetadata: boolean;
  title: string;
}

export function resolveIssueManagerTaskDrawerViewState(input: {
  controller: Pick<
    IssueManagerController,
    | "copy"
    | "isTuttiModePlanIssue"
    | "taskDetail"
    | "taskDraft"
    | "taskEditorMode"
  >;
  selectedTask: IssueManagerTaskSummary | null;
}): IssueManagerTaskDrawerViewState {
  const { controller, selectedTask } = input;
  const isCreate = controller.taskEditorMode === "create";
  const isEdit = controller.taskEditorMode === "edit";
  const isRead = !isCreate && !isEdit;
  const showTaskMetadata = isRead && selectedTask !== null;
  const showMutableTaskControls =
    showTaskMetadata && !controller.isTuttiModePlanIssue;
  const bodyKind =
    controller.taskDetail.isLoading &&
    isCreate === false &&
    controller.taskDetail.value === null
      ? "loading"
      : isCreate || isEdit
        ? "edit"
        : "read";

  return {
    bodyKind,
    isCreate,
    isEdit,
    isRead,
    isTaskTitleMissing: controller.taskDraft.title.trim().length === 0,
    showEditFooter: isCreate || isEdit,
    showReadFooter: showMutableTaskControls,
    showTaskActions: showMutableTaskControls,
    showTaskMetadata,
    title:
      isCreate || isEdit
        ? isCreate
          ? controller.copy.t("actions.createTask")
          : controller.copy.t("actions.editTask")
        : selectedTask?.title || controller.copy.t("labels.taskDetails")
  };
}

export function resolveIssueManagerTaskRefs(input: {
  controller: Pick<IssueManagerController, "taskDetail">;
}): IssueManagerContextRef[] {
  return (
    input.controller.taskDetail.value?.contextRefs.filter(
      (ref) => ref.parentKind === "task"
    ) ?? []
  );
}

export function canIssueManagerSaveTask(input: {
  selectedIssue: IssueManagerIssueSummary | null;
  view: Pick<IssueManagerTaskDrawerViewState, "isTaskTitleMissing">;
}): boolean {
  return (
    input.selectedIssue !== null && input.view.isTaskTitleMissing === false
  );
}

export function isIssueManagerRunControlDisabled(input: {
  disabled?: boolean;
  selectedIssueStatus: IssueManagerStatus | null | undefined;
  selectedTaskStatus: IssueManagerStatus | null | undefined;
}): boolean {
  if (input.disabled === true) {
    return true;
  }
  return (input.selectedTaskStatus ?? input.selectedIssueStatus) === "running";
}
