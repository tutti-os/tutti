import {
  dispatchCollaborationOperation,
  type AgentActivityCollaborationRun
} from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "@tutti-os/agent-gui";

let handoffRequestSequence = 0;

export async function startDesktopAgentGUIHandoff(input: {
  agentActivityRuntime: AgentActivityRuntime | null;
  question: string;
  sourceAgentSessionId: string;
  targetAgentTargetId: string;
  workspaceId: string;
  openTargetSession: (agentSessionId: string) => Promise<void>;
}): Promise<AgentActivityCollaborationRun> {
  if (!input.agentActivityRuntime?.collaborationCommandSupport) {
    throw new Error("agent_handoff_unavailable");
  }
  const engine = input.agentActivityRuntime.getSessionEngine(input.workspaceId);
  const requestId = `desktop-handoff:${input.sourceAgentSessionId}:${++handoffRequestSequence}`;
  const run = await dispatchCollaborationOperation(engine, {
    input: {
      agentSessionId: input.sourceAgentSessionId,
      contextScope: "recent",
      contextText: null,
      mode: "handoff",
      question: input.question,
      targetAgentTargetId: input.targetAgentTargetId,
      triggerReason: "handoff_menu",
      workspaceId: input.workspaceId
    },
    requestId,
    type: "collaboration/startRequested"
  });
  const targetSessionId = run.targetSessionId?.trim();
  if (run.status === "failed" || !targetSessionId) {
    throw new Error(run.failureReason?.trim() || "agent_handoff_failed");
  }
  await input.openTargetSession(targetSessionId);
  return run;
}
