import type { AgentActivityCollaborationRun } from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";

export async function startDesktopAgentGUIHandoff(input: {
  agentActivityRuntime: AgentActivityRuntime | null;
  question: string;
  sourceAgentSessionId: string;
  targetAgentTargetId: string;
  workspaceId: string;
  openTargetSession: (agentSessionId: string) => Promise<void>;
}): Promise<AgentActivityCollaborationRun> {
  const startAgentCollaboration =
    input.agentActivityRuntime?.startAgentCollaboration;
  if (!startAgentCollaboration) {
    throw new Error("agent_handoff_unavailable");
  }
  const run = await startAgentCollaboration({
    agentSessionId: input.sourceAgentSessionId,
    contextScope: "recent",
    contextText: null,
    mode: "handoff",
    question: input.question,
    targetAgentTargetId: input.targetAgentTargetId,
    triggerReason: "handoff_menu",
    workspaceId: input.workspaceId
  });
  const targetSessionId = run.targetSessionId?.trim();
  if (run.status === "failed" || !targetSessionId) {
    throw new Error(run.failureReason?.trim() || "agent_handoff_failed");
  }
  await input.openTargetSession(targetSessionId);
  return run;
}
