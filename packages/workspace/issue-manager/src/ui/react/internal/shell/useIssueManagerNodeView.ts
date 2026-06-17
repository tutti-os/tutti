import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";
import type { ReactNode } from "react";
import type {
  IssueManagerFileReference,
  IssueManagerNodeState,
  IssueManagerOpenSource
} from "../../../../contracts/index.ts";
import type { IssueManagerFeature } from "../../../../core/index.ts";
import type { IssueManagerControllerService } from "../../../../services/issueManagerControllerService.interface.ts";
import {
  resolveIssueManagerSelectedIssue,
  resolveIssueManagerSelectedTask,
  useIssueManagerTaskListCollapsedSync
} from "./IssueManagerNodeState.ts";
import {
  useIssueManagerController,
  type IssueManagerController,
  type IssueManagerRichTextSurface
} from "../controller/useIssueManagerController.ts";
import {
  logIssueManagerDiagnostic,
  type IssueManagerDiagnostics
} from "../../../../internal/issueManagerDiagnostics.ts";

export interface UseIssueManagerNodeViewInput {
  diagnostics?: IssueManagerDiagnostics | null;
  emptyIllustration?: ReactNode;
  feature: IssueManagerFeature;
  nodeId: string;
  openSource?: IssueManagerOpenSource;
  onStateChange?: (state: IssueManagerNodeState) => void;
  resolveRichTextTriggerProviders?: (input: {
    surface: IssueManagerRichTextSurface;
    workspaceId: string;
  }) => readonly RichTextTriggerProvider[];
  service?: IssueManagerControllerService;
  state?: Partial<IssueManagerNodeState> | null;
  workspaceId: string;
}

export function useIssueManagerNodeView({
  diagnostics,
  feature,
  nodeId,
  openSource,
  onStateChange,
  resolveRichTextTriggerProviders,
  service,
  state,
  workspaceId
}: UseIssueManagerNodeViewInput) {
  const controller = useIssueManagerController({
    diagnostics,
    feature,
    openSource,
    onStateChange,
    resolveRichTextTriggerProviders,
    service,
    state,
    workspaceId
  });

  useIssueManagerTaskListCollapsedSync({
    nodeId,
    onCollapsedChange: (collapsed) => {
      controller.setTaskListCollapsed(collapsed);
    },
    workspaceId
  });

  const selectedIssue = resolveIssueManagerSelectedIssue({
    issueDetail: controller.issueDetail.value?.issue ?? null,
    issues: controller.issues.value,
    selectedIssueId: controller.nodeState.selectedIssueId
  });
  const selectedTask = resolveIssueManagerSelectedTask({
    selectedTaskId: controller.nodeState.selectedTaskId,
    taskDetail: controller.taskDetail.value?.task ?? null,
    tasks: controller.issueDetail.value?.tasks ?? []
  });

  return {
    controller,
    referencePicker: {
      onClose: () => {
        controller.setReferenceTarget(null);
      },
      onConfirm: (refs: IssueManagerFileReference[]) => {
        void controller.submitReferenceSelection(refs);
      },
      open: controller.referenceTarget !== null
    },
    selectedIssue,
    selectedTask,
    shell: {
      onCloseTaskDrawer: () => {
        logIssueManagerDiagnostic(
          controller.diagnostics,
          "task_drawer.close_requested",
          {
            selectedIssueId: controller.nodeState.selectedIssueId,
            selectedTaskId: controller.nodeState.selectedTaskId
          }
        );
        controller.selectTask(null);
      },
      onDismissIssueCreate: () => {
        controller.setIssueEditorMode("read");
      }
    }
  };
}

export type IssueManagerNodeView = ReturnType<typeof useIssueManagerNodeView>;
export type IssueManagerNodeViewController = IssueManagerController;
