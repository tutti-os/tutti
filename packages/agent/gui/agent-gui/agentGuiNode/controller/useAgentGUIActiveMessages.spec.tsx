import { renderHook } from "@testing-library/react";
import type {
  AgentActivityMessage,
  EditRetryTailPresentation,
  PendingActivationIntentRecord
} from "@tutti-os/agent-activity-core";
import { describe, expect, it } from "vitest";
import { useAgentGUIActiveMessages } from "./useAgentGUIActiveMessages";

type NewPendingActivationIntentRecord = Extract<
  PendingActivationIntentRecord,
  { mode: "new" }
>;

describe("useAgentGUIActiveMessages", () => {
  it("does not rematerialize an authoritatively retracted initial prompt", () => {
    const storedMessage = message("replacement", "replacement-submit");
    const { result } = renderHook(() =>
      useAgentGUIActiveMessages({
        activeConversationId: "session-1",
        editRetryTail: null,
        activePendingActivation: activation({ initialPromptRetracted: true }),
        activePendingSubmits: [],
        activeQueuedPrompts: [],
        currentUserId: "user-1",
        storedMessages: [storedMessage],
        workspaceId: "workspace-1"
      })
    );

    expect(result.current.activeMessages).toEqual([storedMessage]);
  });

  it("keeps an unretracted initial prompt optimistic until canonical confirmation", () => {
    const { result } = renderHook(() =>
      useAgentGUIActiveMessages({
        activeConversationId: "session-1",
        editRetryTail: null,
        activePendingActivation: activation({
          initialPromptRetracted: false
        }),
        activePendingSubmits: [],
        activeQueuedPrompts: [],
        currentUserId: "user-1",
        storedMessages: [],
        workspaceId: "workspace-1"
      })
    );

    expect(result.current.activeMessages).toHaveLength(1);
    expect(result.current.activeMessages[0]?.payload).toMatchObject({
      __agentGuiOptimisticPrompt: true,
      clientSubmitId: "initial-submit"
    });
  });

  it("replaces the retracted tail with the edited optimistic prompt", () => {
    const { result } = renderHook(() =>
      useAgentGUIActiveMessages({
        activeConversationId: "session-1",
        activePendingActivation: null,
        activePendingSubmits: [],
        activeQueuedPrompts: [],
        currentUserId: "user-1",
        editRetryTail: tail(),
        storedMessages: [
          message("before", "before-submit", "turn-before"),
          message("retracted", "old-submit", "turn-retracted")
        ],
        workspaceId: "workspace-1"
      })
    );

    expect(result.current.activeMessages).toHaveLength(2);
    expect(result.current.activeMessages.map((item) => item.turnId)).toEqual([
      "turn-before",
      "pending:edit-retry:operation-1"
    ]);
    expect(result.current.activeMessages[1]?.payload).toMatchObject({
      clientSubmitId: "edit-retry:operation-1",
      text: "edited prompt"
    });
  });
});

function tail(): EditRetryTailPresentation {
  return {
    clientOperationId: "operation-1",
    editedText: "edited prompt",
    operationId: null,
    replacementTurnId: null,
    retractedTurnId: "turn-retracted",
    workspaceId: "workspace-1"
  };
}

function activation(
  patch: Partial<NewPendingActivationIntentRecord>
): NewPendingActivationIntentRecord {
  return {
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    clientSubmitId: "initial-submit",
    content: [{ type: "text", text: "old prompt" }],
    cwd: "/workspace",
    errorCode: null,
    errorMessage: null,
    expiresAtUnixMs: 120_000,
    initialPromptRetracted: false,
    initialTurnExpected: true,
    mode: "new",
    requestedAtUnixMs: 1,
    requestId: "activation-1",
    status: "confirmed",
    title: "Session",
    workspaceId: "workspace-1",
    ...patch
  };
}

function message(
  messageId: string,
  clientSubmitId: string,
  turnId = "replacement-turn"
): AgentActivityMessage {
  return {
    agentSessionId: "session-1",
    kind: "text",
    messageId,
    occurredAtUnixMs: 2,
    payload: { clientSubmitId, text: "replacement prompt" },
    role: "user",
    turnId,
    version: 1,
    workspaceId: "workspace-1"
  };
}
