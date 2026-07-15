import type { IssueManagerOpenActivationPayload } from "@tutti-os/workspace-issue-manager/workbench";
import { defaultIssueManagerWorkbenchTypeId } from "@tutti-os/workspace-issue-manager/workbench/constants";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import type {
  WorkspaceIssueManagerLaunchPresenter,
  WorkspaceIssueManagerLaunchRequest
} from "./workspaceIssueManagerLaunchCoordinator.ts";

// Value mirror of the stable Issue Manager activation protocol. Keeping it
// local lets the pure presenter tests avoid loading the React workbench barrel.
const workbenchIssueManagerOpenActivationType = "open-workspace-issue";

export function createWorkbenchWorkspaceIssueManagerPresenter(input: {
  host: WorkbenchHostHandle;
}): WorkspaceIssueManagerLaunchPresenter {
  return {
    async present(request) {
      return openWorkspaceIssueManagerNode(input.host, request);
    }
  };
}

async function openWorkspaceIssueManagerNode(
  host: WorkbenchHostHandle,
  request: WorkspaceIssueManagerLaunchRequest
): Promise<boolean> {
  const nodeId = await host.launchNode({
    launchSource: "agent_command",
    reason: "host",
    typeId: defaultIssueManagerWorkbenchTypeId
  });
  if (!nodeId) {
    return false;
  }
  if (!request.issueId) {
    return true;
  }

  const payload: IssueManagerOpenActivationPayload = {
    issueId: request.issueId,
    ...(request.mode ? { mode: request.mode } : {}),
    ...(request.outputDir ? { outputDir: request.outputDir } : {}),
    ...(request.runId ? { runId: request.runId } : {}),
    ...(request.taskId ? { taskId: request.taskId } : {}),
    ...(request.topicId ? { topicId: request.topicId } : {})
  };
  host.activateNode(
    { nodeId },
    {
      payload,
      type: workbenchIssueManagerOpenActivationType
    }
  );
  return true;
}
