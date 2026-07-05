import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";
import type { IssueManagerNodeState } from "../../../../contracts/index.ts";
import type { IssueManagerFeature } from "../../../../core/index.ts";
import type {
  IssueManagerControllerSession,
  IssueManagerEditorMode,
  IssueManagerReferenceTarget
} from "../../../../services/issueManagerControllerService.interface.ts";
import { applyIssueManagerIssueSelection } from "../../../../services/internal/controllerState.ts";
import { createIssueManagerIssueBindings } from "../issue/createIssueManagerIssueBindings.ts";
import { createIssueManagerTaskBindings } from "../task/createIssueManagerTaskBindings.ts";
import {
  logIssueManagerDiagnostic,
  type IssueManagerDiagnostics
} from "../../../../internal/issueManagerDiagnostics.ts";

export function createIssueManagerControllerBindings(input: {
  controllerSession: IssueManagerControllerSession;
  diagnostics?: IssueManagerDiagnostics | null;
  feature: IssueManagerFeature;
  issueEditorMode: IssueManagerEditorMode;
  nodeState: IssueManagerNodeState;
  onResolveRichTextTriggerProviders?: (input: {
    surface: "issue" | "task";
    workspaceId: string;
  }) => readonly RichTextTriggerProvider[];
  taskEditorMode: IssueManagerEditorMode;
  workspaceId: string;
}) {
  const {
    controllerSession,
    diagnostics,
    feature,
    issueEditorMode,
    nodeState,
    onResolveRichTextTriggerProviders,
    taskEditorMode,
    workspaceId
  } = input;

  const issueBindings = createIssueManagerIssueBindings({
    controllerSession,
    diagnostics,
    feature,
    issueEditorMode,
    nodeState
  });
  const taskBindings = createIssueManagerTaskBindings({
    controllerSession,
    diagnostics,
    feature,
    nodeState,
    taskEditorMode
  });

  return {
    ...issueBindings,
    ...taskBindings,
    dismissNotification() {
      controllerSession.setNotification(null);
    },
    refreshAll() {
      controllerSession.refreshAll();
    },
    reportIssueSearchUsage(query: string) {
      controllerSession.reportIssueSearchUsage(query);
    },
    resolveRichTextTriggerProviders(surface: "issue" | "task") {
      return (
        onResolveRichTextTriggerProviders?.({
          surface,
          workspaceId
        }) ?? []
      );
    },
    selectIssue(issueId: string | null) {
      controllerSession.updateNodeState((current) => {
        logIssueManagerDiagnostic(
          diagnostics,
          "issue_selection.requested",
          {
            nextSelectedIssueId: issueId,
            previousSelectedIssueId: current.selectedIssueId,
            previousSelectedTaskId: current.selectedTaskId
          },
          { includeStack: true }
        );
        return applyIssueManagerIssueSelection(current, issueId);
      });
      controllerSession.setIssueEditorModeState("read");
      controllerSession.setTaskEditorModeState("read");
    },
    setReferenceTarget(target: IssueManagerReferenceTarget | null) {
      controllerSession.setReferenceTarget(target);
    },
    setSelectedAgentTargetId(agentTargetId: string) {
      controllerSession.updateNodeState((current) => ({
        ...current,
        selectedAgentTargetId: agentTargetId
      }));
    }
  };
}
