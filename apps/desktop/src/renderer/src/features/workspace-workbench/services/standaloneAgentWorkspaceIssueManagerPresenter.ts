import {
  createStandaloneAgentIssueManagerOpenRequest,
  type StandaloneAgentIssueManagerOpenRequest
} from "./standaloneAgentIssueManagerLaunch.ts";
import type { WorkspaceIssueManagerLaunchPresenter } from "./workspaceIssueManagerLaunchCoordinator.ts";

export function createStandaloneAgentWorkspaceIssueManagerPresenter(input: {
  open(request: StandaloneAgentIssueManagerOpenRequest): void;
}): WorkspaceIssueManagerLaunchPresenter {
  let sequence = 0;
  return {
    present(request) {
      input.open(
        createStandaloneAgentIssueManagerOpenRequest(request, ++sequence)
      );
      return true;
    }
  };
}
