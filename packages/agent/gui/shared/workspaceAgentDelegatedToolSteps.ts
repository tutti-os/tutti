import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes";
import type { WorkspaceAgentSessionDetailToolCall } from "./workspaceAgentSessionDetailViewModel";
import {
  compareToolCallsAscending,
  delegatedToolStepFromCall,
  normalizedPayload,
  stringRecordValue
} from "./workspaceAgentTimelineProjectionHelpers";

export function appendDelegatedToolSteps(
  parentCall: WorkspaceAgentSessionDetailToolCall,
  childCalls: readonly WorkspaceAgentSessionDetailToolCall[]
): void {
  const nextPayload = parentCall.payload ? { ...parentCall.payload } : {};
  const nextMetadata =
    normalizedPayload(
      nextPayload.metadata as WorkspaceAgentActivityTimelineItem["payload"]
    ) ?? {};
  const existingSteps = Array.isArray(nextMetadata.steps)
    ? [...nextMetadata.steps]
    : [];
  const existingStepIDs = new Set(
    existingSteps
      .map((step) =>
        normalizedPayload(step as WorkspaceAgentActivityTimelineItem["payload"])
      )
      .map(
        (step) =>
          stringRecordValue(step, "toolUseId") ?? stringRecordValue(step, "id")
      )
      .filter((value): value is string => Boolean(value))
  );
  for (const childCall of [...childCalls].sort(compareToolCallsAscending)) {
    const step = delegatedToolStepFromCall(childCall);
    const stepID =
      stringRecordValue(step, "toolUseId") ?? stringRecordValue(step, "id");
    if (stepID && existingStepIDs.has(stepID)) {
      continue;
    }
    if (stepID) {
      existingStepIDs.add(stepID);
    }
    existingSteps.push(step);
  }
  nextMetadata.steps = existingSteps;
  nextPayload.metadata = nextMetadata;
  parentCall.payload = nextPayload;
}
