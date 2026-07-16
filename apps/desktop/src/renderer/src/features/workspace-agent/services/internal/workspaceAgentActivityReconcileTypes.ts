import type {
  AgentActivitySession,
  AgentActivityTurn,
  AgentActivityUpdatedEvent
} from "@tutti-os/agent-activity-core";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";

export interface WorkspaceAgentActivityReconcileDependencies {
  eventStreamClient?: TuttidEventStreamClient;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  tuttidClient: TuttidClient;
}

export interface AgentActivitySessionDetail {
  session: AgentActivitySession;
  childSessions: AgentActivitySession[];
  turns: AgentActivityTurn[];
}

export type WorkspaceAgentActivityBridgeEvent =
  | AgentActivityUpdatedEvent
  | {
      agentSessionId: string;
      data: unknown;
      eventType: "state_patch";
      workspaceId: string;
    };
