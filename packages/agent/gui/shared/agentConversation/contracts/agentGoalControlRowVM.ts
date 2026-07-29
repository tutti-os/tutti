import type { AgentActivityGoalControlAction } from "@tutti-os/agent-activity-core";
import type { WorkspaceAgentActivityTimelineItem } from "../../workspaceAgentTimelineTypes";

export interface AgentGoalControlRowVM {
  kind: "goal-control";
  id: string;
  turnId: null;
  action: AgentActivityGoalControlAction;
  body: string;
  occurredAtUnixMs: number | null;
  sourceTimelineItems?: WorkspaceAgentActivityTimelineItem[];
}
