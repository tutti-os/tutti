import type { AgentGUIRuntime } from "@tutti-os/agent-gui";
import { useAgentSessionReplayNodeReadiness } from "./AgentSessionReplayWorkspaceBinding.tsx";

export function AgentSessionReplayNodeReadiness({
  agentActivityRuntime,
  nodeId,
  selectedAgentSessionId,
  workspaceId
}: {
  agentActivityRuntime: AgentGUIRuntime;
  nodeId: string;
  selectedAgentSessionId: string | null;
  workspaceId: string;
}): null {
  useAgentSessionReplayNodeReadiness({
    agentActivityRuntime,
    nodeId,
    selectedAgentSessionId,
    workspaceId
  });
  return null;
}
