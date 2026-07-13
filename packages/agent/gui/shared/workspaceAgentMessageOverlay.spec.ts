import { describe, expect, it } from "vitest";
import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import {
  createWorkspaceAgentActivityUserMessageIdFromClientSubmitId,
  mergeWorkspaceAgentActivityDurableAndOverlayMessages,
  selectWorkspaceAgentActivityOverlayMessages
} from "./workspaceAgentMessageOverlay";
import {
  isWorkspaceAgentActivityRuntimeSessionOrigin,
  WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN
} from "./workspaceAgentSessionOrigin";

describe("isWorkspaceAgentActivityRuntimeSessionOrigin", () => {
  it("accepts only empty origin or the explicit runtime enum", () => {
    expect(isWorkspaceAgentActivityRuntimeSessionOrigin(undefined)).toBe(true);
    expect(isWorkspaceAgentActivityRuntimeSessionOrigin("")).toBe(true);
    expect(
      isWorkspaceAgentActivityRuntimeSessionOrigin(
        WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN
      )
    ).toBe(true);

    expect(
      isWorkspaceAgentActivityRuntimeSessionOrigin(
        "workspace_agent_session_origin_runtime"
      )
    ).toBe(false);
    expect(isWorkspaceAgentActivityRuntimeSessionOrigin("runtime")).toBe(false);
    expect(isWorkspaceAgentActivityRuntimeSessionOrigin("1")).toBe(false);
    expect(
      isWorkspaceAgentActivityRuntimeSessionOrigin(
        "WORKSPACE_AGENT_SESSION_ORIGIN_UNKNOWN"
      )
    ).toBe(false);
  });
});

describe("selectWorkspaceAgentActivityOverlayMessages", () => {
  it("uses the same client submit derived message id for optimistic and durable user messages", () => {
    const messageId =
      createWorkspaceAgentActivityUserMessageIdFromClientSubmitId("submit-1");
    const durableMessage = userMessage({
      messageId: messageId ?? "",
      version: 2,
      payload: {
        content: [{ text: "hello", type: "text" }],
        text: "hello"
      },
      turnId: "turn-1"
    });
    const optimisticMessage = userMessage({
      messageId: messageId ?? "",
      payload: {
        __agentGuiOptimisticPrompt: true,
        clientSubmitId: "submit-1",
        content: [
          { type: "skill", name: "caveman", path: "$caveman" },
          { type: "text", text: "hello" }
        ],
        text: "hello"
      },
      turnId: "pending:submit-1"
    });

    expect(messageId).toBe("client-submit:user:submit-1");
    expect(
      mergeWorkspaceAgentActivityDurableAndOverlayMessages({
        durableMessages: [durableMessage],
        localMessages: [optimisticMessage]
      })
    ).toEqual([durableMessage]);
  });

  it("drops an optimistic user prompt by matching client submit id", () => {
    const durableMessage = userMessage({
      messageId: "durable-user-1",
      payload: {
        clientSubmitId: "submit-1",
        text: "durable prompt text"
      },
      turnId: "turn-1"
    });
    const optimisticMessage = userMessage({
      messageId: "optimistic:user:initial:session-1",
      payload: {
        __agentGuiOptimisticPrompt: true,
        clientSubmitId: "submit-1",
        text: "local prompt text"
      },
      turnId: "pending:submit-1"
    });

    expect(
      selectWorkspaceAgentActivityOverlayMessages({
        durableMessages: [durableMessage],
        localMessages: [optimisticMessage]
      })
    ).toEqual([]);
  });

  it("drops an optimistic user prompt after the durable prompt is available", () => {
    const durableMessage = userMessage({
      messageId: "durable-user-1",
      payload: { content: [{ text: "hello", type: "text" }], text: "hello" },
      turnId: "turn-1"
    });
    const optimisticMessage = userMessage({
      messageId: "optimistic:user:initial:session-1",
      payload: {
        __agentGuiOptimisticPrompt: true,
        content: [{ type: "text", text: "hello" }],
        text: "hello"
      },
      turnId: "pending:submit-1"
    });

    expect(
      selectWorkspaceAgentActivityOverlayMessages({
        durableMessages: [durableMessage],
        localMessages: [optimisticMessage]
      })
    ).toEqual([]);
  });

  it("keeps an optimistic user prompt until a matching durable prompt arrives", () => {
    const optimisticMessage = userMessage({
      messageId: "optimistic:user:initial:session-1",
      payload: { __agentGuiOptimisticPrompt: true, text: "hello" },
      turnId: "pending:submit-1"
    });

    expect(
      selectWorkspaceAgentActivityOverlayMessages({
        durableMessages: [
          userMessage({
            messageId: "durable-user-1",
            payload: { text: "different" },
            turnId: "turn-1"
          })
        ],
        localMessages: [optimisticMessage]
      })
    ).toEqual([optimisticMessage]);
  });

  it("keeps a repeated optimistic user prompt with a new client submit id", () => {
    const previousDurablePrompt = userMessage({
      messageId: "durable-user-1",
      payload: {
        text: "run tests"
      },
      turnId: "turn-1"
    });
    const repeatedOptimisticPrompt = userMessage({
      messageId: "client-submit:user:submit-2",
      payload: {
        __agentGuiOptimisticPrompt: true,
        clientSubmitId: "submit-2",
        text: "run tests"
      },
      turnId: "pending:submit-2"
    });

    expect(
      selectWorkspaceAgentActivityOverlayMessages({
        durableMessages: [previousDurablePrompt],
        localMessages: [repeatedOptimisticPrompt]
      })
    ).toEqual([repeatedOptimisticPrompt]);
  });
});

// Step 9: optimistic echoes live outside the durable version domain
// (version 0), so ordering must come from the domain split - durable rows
// first (version order), surviving echoes appended after them - never from a
// raw version sort across both domains.
describe("mergeWorkspaceAgentActivityDurableAndOverlayMessages ordering", () => {
  it("renders surviving optimistic echoes after all durable rows", () => {
    const durableAsk = userMessage({
      messageId: "user-5",
      version: 5,
      occurredAtUnixMs: 5000
    });
    const durableAnswer = userMessage({
      messageId: "assistant-6",
      version: 6,
      role: "assistant",
      payload: { text: "answer" },
      occurredAtUnixMs: 6000
    });
    const echo = userMessage({
      messageId: "client-submit:user:submit-1",
      version: 0,
      turnId: "pending:submit-1",
      payload: {
        __agentGuiOptimisticPrompt: true,
        clientSubmitId: "submit-1",
        text: "new ask"
      },
      occurredAtUnixMs: 7000
    });

    const merged = mergeWorkspaceAgentActivityDurableAndOverlayMessages({
      durableMessages: [durableAsk, durableAnswer],
      localMessages: [echo]
    });

    expect(merged.map((message) => message.messageId)).toEqual([
      "user-5",
      "assistant-6",
      "client-submit:user:submit-1"
    ]);
  });

  it("orders multiple surviving echoes by occurredAt", () => {
    const durableAsk = userMessage({
      messageId: "user-5",
      version: 5,
      occurredAtUnixMs: 5000
    });
    const echoLater = userMessage({
      messageId: "client-submit:user:submit-2",
      version: 0,
      turnId: "pending:submit-2",
      payload: {
        __agentGuiOptimisticPrompt: true,
        clientSubmitId: "submit-2",
        text: "second ask"
      },
      occurredAtUnixMs: 8000
    });
    const echoEarlier = userMessage({
      messageId: "client-submit:user:submit-1",
      version: 0,
      turnId: "pending:submit-1",
      payload: {
        __agentGuiOptimisticPrompt: true,
        clientSubmitId: "submit-1",
        text: "first ask"
      },
      occurredAtUnixMs: 7000
    });

    const merged = mergeWorkspaceAgentActivityDurableAndOverlayMessages({
      durableMessages: [durableAsk],
      localMessages: [echoLater, echoEarlier]
    });

    expect(merged.map((message) => message.messageId)).toEqual([
      "user-5",
      "client-submit:user:submit-1",
      "client-submit:user:submit-2"
    ]);
  });
});

function userMessage(
  overrides: Partial<AgentActivityMessage> & { id?: number }
): AgentActivityMessage {
  const { id: _legacyStorageId, ...canonical } = overrides;
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    messageId: "message-1",
    version: 1,
    turnId: "turn-1",
    role: "user",
    kind: "text",
    payload: { text: "hello" },
    occurredAtUnixMs: 1000,
    ...canonical
  };
}
