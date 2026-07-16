import type { AgentActivityUpdatedEvent } from "@tutti-os/agent-activity-core";
import type { TuttidEventStreamClient } from "@tutti-os/client-tuttid-ts";
import type { WorkspaceAgentModelConfigurationChangedEvent } from "../workspaceAgentActivityService.interface.ts";
import type { WorkspaceAgentSessionEngineHost } from "./workspaceAgentSessionEngineHost.ts";
import { subscribeWorkspaceAgentModelConfigurationChanges } from "./workspaceAgentModelConfigurationBridge.ts";

export function subscribeWorkspaceAgentScopedEvents(input: {
  eventStreamClient?: TuttidEventStreamClient;
  modelConfigurationChangedListeners: ReadonlySet<
    (event: WorkspaceAgentModelConfigurationChangedEvent) => void
  >;
  onAgentActivityUpdated: (event: AgentActivityUpdatedEvent) => void;
  sessionEngineHost: WorkspaceAgentSessionEngineHost | undefined;
  workspaceId: string;
}): void {
  const eventStreamClient = input.eventStreamClient;
  if (!eventStreamClient) return;

  eventStreamClient.subscribe(
    "agent.activity.updated",
    (event) => {
      const payload = event.payload;
      if (payload.workspaceId.trim() !== input.workspaceId) return;
      input.onAgentActivityUpdated(payload);
    },
    { scope: { workspaceId: input.workspaceId } }
  );
  eventStreamClient.subscribe(
    "workspace.tuttimode.updated",
    (event) => {
      const agentSessionId = event.payload.agentSessionId.trim();
      if (!agentSessionId) return;
      input.sessionEngineHost?.engine.dispatch({
        agentSessionId,
        needsMessages: false,
        needsState: true,
        type: "session/reconcileRequested",
        workspaceId: input.workspaceId
      });
    },
    { scope: { workspaceId: input.workspaceId } }
  );
  subscribeWorkspaceAgentModelConfigurationChanges({
    eventStreamClient,
    listeners: input.modelConfigurationChangedListeners,
    sessionEngineHost: input.sessionEngineHost,
    workspaceId: input.workspaceId
  });
}
