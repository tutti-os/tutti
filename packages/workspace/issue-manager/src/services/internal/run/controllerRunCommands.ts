import type {
  IssueManagerIssueDetail,
  IssueManagerTaskDetail
} from "../../../contracts/index.ts";
import type { IssueManagerFeature } from "../../../core/index.ts";

export async function executeIssueManagerRunTask(input: {
  agentTargetId: string;
  executionDirectory?: string | null;
  feature: IssueManagerFeature;
  issue: IssueManagerIssueDetail["issue"];
  provider: string;
  task?: IssueManagerTaskDetail["task"];
  workspaceId: string;
}): Promise<{ errorMessage?: string; status: string }> {
  const result = await input.feature.agentRunner.runTask({
    agentTargetId: input.agentTargetId,
    ...(input.executionDirectory?.trim()
      ? { executionDirectory: input.executionDirectory.trim() }
      : {}),
    issue: input.issue,
    provider: input.provider,
    ...(input.task ? { task: input.task } : {}),
    workspaceId: input.workspaceId
  });

  return {
    ...(result.errorMessage?.trim()
      ? { errorMessage: result.errorMessage.trim() }
      : {}),
    status: result.status
  };
}
