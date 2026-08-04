import type * as React from "react";
import { useMemo } from "react";
import { WorkspaceAgentSessionActivityReplayBinding } from "./AgentSessionActivityReplayBinding.tsx";
import { AgentSessionReplayWorkspaceBinding } from "./AgentSessionReplayWorkspaceBinding.tsx";
import { AgentSessionReplayWorkspaceProvider } from "./AgentSessionReplayWorkspaceContext.tsx";
import {
  AgentSessionReplayWorkspaceCoordinator,
  type AgentSessionReplayNodeLaunchRequest
} from "../services/agentSessionReplayWorkspaceCoordinator.ts";

interface AgentSessionReplayActivitySource {
  addSessionEngineActivityObserver: Parameters<
    typeof WorkspaceAgentSessionActivityReplayBinding
  >[0]["activitySource"]["addSessionEngineActivityObserver"];
  getSessionEngine: Parameters<
    typeof WorkspaceAgentSessionActivityReplayBinding
  >[0]["activitySource"]["getSessionEngine"];
}

export function AgentSessionReplayWorkspaceRuntime({
  activitySource,
  arrangeNodes,
  children,
  launchNode,
  workspaceHostReady,
  workspaceId
}: {
  activitySource: AgentSessionReplayActivitySource;
  arrangeNodes(nodeIds: readonly string[]): void;
  children: React.ReactNode;
  launchNode(
    request: AgentSessionReplayNodeLaunchRequest
  ): Promise<string | null>;
  workspaceHostReady: boolean;
  workspaceId: string;
}): React.JSX.Element {
  const coordinator = useMemo(
    () => new AgentSessionReplayWorkspaceCoordinator(workspaceId),
    [workspaceId]
  );

  return (
    <AgentSessionReplayWorkspaceProvider value={coordinator}>
      <WorkspaceAgentSessionActivityReplayBinding
        activitySource={activitySource}
        workspaceId={workspaceId}
      />
      {workspaceHostReady ? (
        <AgentSessionReplayWorkspaceBinding
          arrangeNodes={arrangeNodes}
          coordinator={coordinator}
          launchNode={launchNode}
        />
      ) : null}
      {children}
    </AgentSessionReplayWorkspaceProvider>
  );
}
