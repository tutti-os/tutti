import type {
  IssueManagerIssueDetail,
  IssueManagerTaskDetail
} from "../../../contracts/index.ts";
import type { IssueManagerFeature } from "../../../core/index.ts";

export async function executeIssueManagerRunTask(input: {
  executionDirectory?: string | null;
  feature: IssueManagerFeature;
  issue: IssueManagerIssueDetail["issue"];
  provider: string;
  task?: IssueManagerTaskDetail["task"];
  workspaceId: string;
}): Promise<{ errorMessage?: string; status: string }> {
  const agentSessionId = createIssueManagerAgentSessionId();
  const result = await input.feature.agentRunner.runTask({
    agentSessionId,
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

function createIssueManagerAgentSessionId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.();
  if (randomUUID) {
    return randomUUID;
  }
  const bytes = new Uint8Array(16);
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
