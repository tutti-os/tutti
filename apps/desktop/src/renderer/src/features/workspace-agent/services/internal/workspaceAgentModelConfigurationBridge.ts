import type { TuttidEventStreamClient } from "@tutti-os/client-tuttid-ts";
import type { WorkspaceAgentModelConfigurationChangedEvent } from "../workspaceAgentActivityService.interface.ts";
import type { WorkspaceAgentSessionEngineHost } from "./workspaceAgentSessionEngineHost.ts";
import { normalizeWorkspaceId } from "./workspaceAgentActivityDiagnostics.ts";

export function subscribeWorkspaceAgentModelConfigurationChanges(input: {
  eventStreamClient: TuttidEventStreamClient;
  listeners: ReadonlySet<
    (event: WorkspaceAgentModelConfigurationChangedEvent) => void
  >;
  sessionEngineHost: WorkspaceAgentSessionEngineHost | undefined;
  workspaceId: string;
}): () => void {
  return input.eventStreamClient.subscribe(
    "agent.model.configuration.changed",
    (event) => {
      const payload = event.payload;
      if (payload.workspaceId.trim() !== input.workspaceId) return;
      publishWorkspaceAgentModelConfigurationChange({
        event: {
          agentTargetIds: [...payload.agentTargetIds],
          defaultModels: { ...payload.defaultModels },
          occurredAtUnixMs: payload.occurredAtUnixMs,
          resetComposerModel: payload.resetComposerModel,
          workspaceId: input.workspaceId
        },
        listeners: input.listeners,
        sessionEngineHost: input.sessionEngineHost
      });
    },
    { scope: { workspaceId: input.workspaceId } }
  );
}

function publishWorkspaceAgentModelConfigurationChange(input: {
  event: WorkspaceAgentModelConfigurationChangedEvent;
  listeners: ReadonlySet<
    (event: WorkspaceAgentModelConfigurationChangedEvent) => void
  >;
  sessionEngineHost: WorkspaceAgentSessionEngineHost | undefined;
}): void {
  const workspaceId = normalizeWorkspaceId(input.event.workspaceId);
  const agentTargetIds = [
    ...new Set(
      input.event.agentTargetIds
        .map((agentTargetId) => agentTargetId.trim())
        .filter(Boolean)
    )
  ];
  if (!workspaceId || agentTargetIds.length === 0) return;
  input.sessionEngineHost?.engine.dispatch({
    targetKeys: agentTargetIds,
    type: "composerOptions/invalidated"
  });
  for (const listener of input.listeners) {
    listener({
      agentTargetIds: [...agentTargetIds],
      defaultModels: { ...input.event.defaultModels },
      occurredAtUnixMs: input.event.occurredAtUnixMs,
      resetComposerModel: input.event.resetComposerModel,
      workspaceId
    });
  }
}
