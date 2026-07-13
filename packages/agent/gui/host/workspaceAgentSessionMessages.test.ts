import { describe, expect, it, vi } from "vitest";
import type { AgentActivityMessage } from "@tutti-os/agent-activity-core";
import {
  loadWorkspaceAgentSessionMessagePages,
  mergeWorkspaceAgentMessages
} from "./workspaceAgentSessionMessages";

describe("loadWorkspaceAgentSessionMessagePages", () => {
  it("keeps following hasMore past the old five-page default", async () => {
    const messages = Array.from({ length: 7 }, (_, index) =>
      messageWithVersion(index + 1)
    );
    const listSessionMessages = vi.fn(async ({ afterVersion = 0 }) => {
      const page = messages
        .filter((message) => message.version > afterVersion)
        .slice(0, 1);
      return {
        messages: page,
        latestVersion: page.at(-1)?.version ?? afterVersion,
        hasMore: messages.some(
          (message) => message.version > (page.at(-1)?.version ?? afterVersion)
        )
      };
    });

    const result = await loadWorkspaceAgentSessionMessagePages({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      limit: 1,
      listSessionMessages
    });

    expect(result.map((message) => message.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7
    ]);
    expect(listSessionMessages).toHaveBeenCalledTimes(7);
  });

  it("uses latestVersion as the next cursor when it advances past returned messages", async () => {
    const listSessionMessages = vi.fn(async ({ afterVersion = 0 }) => {
      if (afterVersion === 0) {
        return {
          messages: [messageWithVersion(1)],
          latestVersion: 10,
          hasMore: true
        };
      }
      if (afterVersion === 10) {
        return {
          messages: [messageWithVersion(11)],
          latestVersion: 11,
          hasMore: false
        };
      }
      return {
        messages: [],
        latestVersion: afterVersion,
        hasMore: false
      };
    });

    const result = await loadWorkspaceAgentSessionMessagePages({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      limit: 20,
      listSessionMessages
    });

    expect(result.map((message) => message.version)).toEqual([1, 11]);
    expect(listSessionMessages).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ afterVersion: 10 })
    );
  });

  it("orders merged messages by canonical activity version", () => {
    const result = mergeWorkspaceAgentMessages(
      [messageWithVersion(2, { messageId: "message-2" })],
      [messageWithVersion(1, { messageId: "message-1" })]
    );

    expect(result.map((message) => message.version)).toEqual([1, 2]);
  });

  it("lets a durable message replace a higher-version optimistic prompt with the same message id", () => {
    const durableUserPrompt = userPromptMessage(1, {
      messageId: "client-submit:user:submit-1",
      payload: {
        clientSubmitId: "submit-1",
        text: "build and run tests"
      }
    });
    const optimisticUserPrompt = optimisticUserPromptMessage({
      clientSubmitId: "submit-1",
      messageId: "client-submit:user:submit-1",
      prompt: "build and run tests",
      version: 1782719873985
    });

    const result = mergeWorkspaceAgentMessages(
      [optimisticUserPrompt],
      [durableUserPrompt]
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.version).toBe(1);
    expect(result[0]?.payload.__agentGuiOptimisticPrompt).toBeUndefined();
  });

  it("drops a higher-version optimistic prompt when durable has the same client submit id", () => {
    const durableUserPrompt = userPromptMessage(1, {
      messageId: "daemon-message-1",
      payload: {
        clientSubmitId: "submit-1",
        text: "build and run tests"
      }
    });
    const optimisticUserPrompt = optimisticUserPromptMessage({
      clientSubmitId: "submit-1",
      messageId: "client-submit:user:submit-1",
      prompt: "build and run tests",
      version: 1782719873985
    });

    const result = mergeWorkspaceAgentMessages(
      [optimisticUserPrompt],
      [durableUserPrompt]
    );

    expect(result.map((message) => message.messageId)).toEqual([
      "daemon-message-1"
    ]);
  });

  it("keeps an unmatched optimistic prompt as a local overlay", () => {
    const durableAssistantMessage = messageWithVersion(50, {
      messageId: "assistant-1"
    });
    const optimisticUserPrompt = optimisticUserPromptMessage({
      clientSubmitId: "submit-2",
      messageId: "client-submit:user:submit-2",
      prompt: "start local server",
      version: 1782719980076
    });

    const result = mergeWorkspaceAgentMessages(
      [durableAssistantMessage],
      [optimisticUserPrompt]
    );

    expect(result.map((message) => message.messageId)).toEqual([
      "assistant-1",
      "client-submit:user:submit-2"
    ]);
    expect(result[1]?.payload.__agentGuiOptimisticPrompt).toBe(true);
  });
});

function messageWithVersion(
  version: number,
  overrides: Partial<AgentActivityMessage> = {}
): AgentActivityMessage {
  return {
    agentSessionId: "session-1",
    kind: "text",
    messageId: `message-${version}`,
    occurredAtUnixMs: version,
    payload: { text: `message ${version}` },
    role: "assistant",
    startedAtUnixMs: version,
    status: "completed",
    turnId: `turn-${version}`,
    version,
    ...overrides
  };
}

function userPromptMessage(
  version: number,
  overrides: Partial<AgentActivityMessage> = {}
): AgentActivityMessage {
  return messageWithVersion(version, {
    role: "user",
    turnId: `turn-user-${version}`,
    ...overrides
  });
}

function optimisticUserPromptMessage(input: {
  clientSubmitId: string;
  messageId: string;
  prompt: string;
  version: number;
}): AgentActivityMessage {
  return userPromptMessage(input.version, {
    messageId: input.messageId,
    occurredAtUnixMs: input.version,
    payload: {
      __agentGuiOptimisticPrompt: true,
      clientSubmitId: input.clientSubmitId,
      text: input.prompt
    },
    startedAtUnixMs: input.version,
    status: "pending",
    turnId: `pending:${input.clientSubmitId}`
  });
}
