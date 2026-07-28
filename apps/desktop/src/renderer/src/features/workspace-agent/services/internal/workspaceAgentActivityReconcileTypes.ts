import type { AgentActivityWorkspaceEventInput } from "@tutti-os/agent-activity-core";
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

export type WorkspaceAgentActivityBridgeEvent =
  AgentActivityWorkspaceEventInput;
