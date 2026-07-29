export type AgentActivityGoalControlAction =
  | "pause"
  | "resume"
  | "clear"
  | "set";

export interface AgentActivityInitialGoalControl {
  action: AgentActivityGoalControlAction;
  objective?: string;
}

export interface AgentActivityGoalControlInput {
  workspaceId: string;
  agentSessionId: string;
  action: AgentActivityGoalControlAction;
  clientSubmitId?: string;
  objective?: string;
  signal?: AbortSignal;
}
