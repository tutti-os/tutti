import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes";
import {
  firstPresentString,
  normalizedPayload,
  stringRecordValue
} from "./workspaceAgentTimelineProjectionHelpers";
import { resolveWorkspaceAgentToolName } from "./workspaceAgentToolCallDisplay";

function toolNameFromItem(
  item: WorkspaceAgentActivityTimelineItem
): string | null {
  return resolveWorkspaceAgentToolName(item);
}

export function normalizeToolName(name: string | null): string {
  return (name ?? "")
    .trim()
    .replace(/[_\s-]+/g, "")
    .toLowerCase();
}

export function suppressedUnavailableAskUserQuestionCallIds(
  items: readonly WorkspaceAgentActivityTimelineItem[]
): Set<string> {
  const suppressed = new Set<string>();
  for (const item of items) {
    if (
      normalizeToolName(toolNameFromItem(item)) !== "askuserquestion" ||
      !isUnavailableAskUserQuestionFailure(item)
    ) {
      continue;
    }
    const callId = toolCallSuppressionId(item);
    if (callId) {
      suppressed.add(callId);
    }
  }
  return suppressed;
}

export function shouldSuppressToolCall(
  item: WorkspaceAgentActivityTimelineItem,
  suppressedToolCallIds: ReadonlySet<string>
): boolean {
  const callId = toolCallSuppressionId(item);
  return callId ? suppressedToolCallIds.has(callId) : false;
}

function toolCallSuppressionId(
  item: WorkspaceAgentActivityTimelineItem
): string | null {
  return firstPresentString(
    item.callId,
    stringRecordValue(item.payload, "callId"),
    stringRecordValue(item.payload, "toolCallId")
  );
}

function isUnavailableAskUserQuestionFailure(
  item: WorkspaceAgentActivityTimelineItem
): boolean {
  const status = firstPresentString(
    item.status,
    stringRecordValue(item.payload, "status")
  );
  if (status !== "failed") {
    return false;
  }
  const payload = normalizedPayload(item.payload);
  const output = normalizedPayload(
    payload?.output as WorkspaceAgentActivityTimelineItem["payload"]
  );
  const error = normalizedPayload(
    payload?.error as WorkspaceAgentActivityTimelineItem["payload"]
  );
  const message = firstPresentString(
    stringRecordValue(output, "output"),
    stringRecordValue(output, "text"),
    stringRecordValue(output, "message"),
    stringRecordValue(error, "error"),
    stringRecordValue(error, "message"),
    stringRecordValue(payload, "error"),
    stringRecordValue(payload, "message")
  );
  return message?.includes("No such tool available: AskUserQuestion") ?? false;
}
