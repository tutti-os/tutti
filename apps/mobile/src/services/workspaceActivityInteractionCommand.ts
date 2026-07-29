import {
  canonicalInteractionKey,
  selectEngineInteractionResponse,
  type AgentActivityInteraction,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import type { WorkspaceActivitySnapshot } from "./workspaceActivityTypes";

type InteractionResponseInput = {
  action?: string;
  optionId?: string;
  payload?: Readonly<Record<string, unknown>>;
};

export function requestWorkspaceActivityInteractionResponse(input: {
  commandId: string;
  engine: AgentSessionEngine;
  interaction: AgentActivityInteraction;
  response?: InteractionResponseInput;
  states: WorkspaceActivitySnapshot["interactionStates"];
  timeoutMs: number;
  workspaceId: string;
}): boolean {
  const interaction = input.interaction;
  const state =
    input.states[
      canonicalInteractionKey(
        interaction.agentSessionId,
        interaction.turnId,
        interaction.requestId
      )
    ];
  if (!state || state.submitting || !state.runtimeAvailable) return false;
  const previousResponse = selectEngineInteractionResponse(
    input.engine.getSnapshot(),
    interaction.agentSessionId,
    interaction.turnId,
    interaction.requestId
  );
  const response = state.failed
    ? previousResponse?.status === "failed"
      ? {
          ...(previousResponse.action
            ? { action: previousResponse.action }
            : {}),
          ...(previousResponse.optionId
            ? { optionId: previousResponse.optionId }
            : {}),
          ...(previousResponse.payload
            ? { payload: { ...previousResponse.payload } }
            : {})
        }
      : null
    : (input.response ?? null);
  if (!response) return false;
  input.engine.dispatch({
    ...response,
    agentSessionId: interaction.agentSessionId,
    commandId: input.commandId,
    requestId: interaction.requestId,
    retry: state.failed,
    timeoutMs: input.timeoutMs,
    turnId: interaction.turnId,
    type: "interaction/responseRequested",
    workspaceId: input.workspaceId
  });
  return true;
}
