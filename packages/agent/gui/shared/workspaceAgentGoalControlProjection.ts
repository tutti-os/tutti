import type { WorkspaceAgentSessionDetailGoalControl } from "./workspaceAgentSessionDetailViewModel";
import type { WorkspaceAgentActivityTimelineItem } from "./workspaceAgentTimelineTypes";
import { normalizedPayload } from "./workspaceAgentTimelineProjectionHelpers";

export function appendWorkspaceAgentGoalControl(
  target: WorkspaceAgentSessionDetailGoalControl[],
  item: WorkspaceAgentActivityTimelineItem,
  id: string,
  body: string
): boolean {
  if (item.itemType !== "goal.control") {
    return false;
  }
  const action = normalizedPayload(item.payload)?.action;
  if (
    action !== "pause" &&
    action !== "resume" &&
    action !== "clear" &&
    action !== "set"
  ) {
    return true;
  }
  const normalizedBody = body.trim();
  if (!normalizedBody) {
    return true;
  }
  target.push({
    id,
    action,
    body: normalizedBody,
    occurredAtUnixMs: item.occurredAtUnixMs ?? item.createdAtUnixMs ?? null,
    sourceTimelineItems: [item]
  });
  return true;
}
