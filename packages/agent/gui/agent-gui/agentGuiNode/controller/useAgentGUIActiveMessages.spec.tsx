import { renderHook } from "@testing-library/react";
import type {
  AgentActivityMessage,
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
});

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
  clientSubmitId: string
): AgentActivityMessage {
  return {
    agentSessionId: "session-1",
    kind: "text",
    messageId,
    occurredAtUnixMs: 2,
    payload: { clientSubmitId, text: "replacement prompt" },
    role: "user",
    turnId: "replacement-turn",
    version: 1,
    workspaceId: "workspace-1"
  };
}
