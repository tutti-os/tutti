import {
  createAgentSideConversationRuntime,
  type AgentSideConversationRuntime,
  type AgentSideConversationStreamEvent
} from "@tutti-os/agent-gui/side-conversation/controller";
import type {
  AgentPromptContentBlock as TuttidAgentPromptContentBlock,
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";

export function createDesktopAgentSideConversationRuntime(input: {
  tuttidClient: TuttidClient;
  eventStreamClient?: TuttidEventStreamClient | null;
  workspaceId: string;
}): AgentSideConversationRuntime | null {
  const sideClient = input.tuttidClient;
  if (
    !input.eventStreamClient ||
    !sideClient.resolveWorkspaceAgentSideCapabilities ||
    !sideClient.openWorkspaceAgentSideConversation ||
    !sideClient.sendWorkspaceAgentSideConversationInput ||
    !sideClient.cancelWorkspaceAgentSideConversationTurn ||
    !sideClient.submitWorkspaceAgentSideConversationInteractive ||
    !sideClient.closeWorkspaceAgentSideConversation
  ) {
    return null;
  }
  return createAgentSideConversationRuntime({
    resolveCapabilities: (workspaceId, sourceAgentSessionId) =>
      sideClient.resolveWorkspaceAgentSideCapabilities!(
        workspaceId,
        sourceAgentSessionId
      ),
    open: async ({
      workspaceId,
      sourceAgentSessionId,
      sideAgentSessionId,
      requestId
    }) =>
      sideClient.openWorkspaceAgentSideConversation!(
        workspaceId,
        sourceAgentSessionId,
        { sideAgentSessionId, requestId }
      ),
    send: async ({
      workspaceId,
      sideAgentSessionId,
      turnId,
      clientSubmitId,
      content,
      displayPrompt
    }) => {
      if (content.some((block) => block.type === "file")) {
        throw new Error("content_unsupported");
      }
      await sideClient.sendWorkspaceAgentSideConversationInput!(
        workspaceId,
        sideAgentSessionId,
        {
          turnId,
          clientSubmitId,
          content: [...content] as TuttidAgentPromptContentBlock[],
          displayPrompt
        }
      );
    },
    cancel: async ({ workspaceId, sideAgentSessionId, turnId }) => {
      await sideClient.cancelWorkspaceAgentSideConversationTurn!(
        workspaceId,
        sideAgentSessionId,
        turnId
      );
    },
    respond: async ({
      workspaceId,
      sideAgentSessionId,
      turnId,
      requestId,
      action,
      optionId,
      payload
    }) => {
      await sideClient.submitWorkspaceAgentSideConversationInteractive!(
        workspaceId,
        sideAgentSessionId,
        turnId,
        requestId,
        { action, optionId, payload }
      );
    },
    close: ({ workspaceId, sideAgentSessionId }) =>
      sideClient.closeWorkspaceAgentSideConversation!(
        workspaceId,
        sideAgentSessionId
      ),
    subscribe(listener) {
      return input.eventStreamClient!.subscribe(
        "agent.side.updated",
        (event) => {
          if (event.payload.workspaceId !== input.workspaceId) return;
          listener(event.payload satisfies AgentSideConversationStreamEvent);
        },
        { scope: { workspaceId: input.workspaceId } }
      );
    },
    subscribeConnectionState(listener) {
      return input.eventStreamClient!.subscribeConnectionState(listener);
    },
    getConnectionState() {
      return input.eventStreamClient!.getConnectionState?.() ?? "disconnected";
    }
  });
}
