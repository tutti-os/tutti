import type {
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import {
  delegatedAgentToolResult,
  delegatedAgentToolUse
} from "./sessionRuntimeTestCommon.ts";

export function fakeRacedDelegatedTaskAliasQuery(
  prompt: AsyncIterable<SDKUserMessage>
): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield delegatedAgentToolUse("toolu-agent-1", "First task");
      yield delegatedAgentToolResult("toolu-agent-1", "agent-1");
      // Claude Code puts the agent id into task_id; this event races ahead of
      // the second launch result, so its alias is still unknown here.
      yield {
        type: "system",
        subtype: "task_started",
        task_id: "agent-2",
        description: "Second task"
      } as unknown as SDKMessage;
      yield delegatedAgentToolUse("toolu-agent-2", "Second task");
      yield delegatedAgentToolResult("toolu-agent-2", "agent-2");
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      yield {
        type: "system",
        subtype: "task_notification",
        task_id: "agent-2",
        status: "completed",
        summary: "Second task complete"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakeDelegatedTaskQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  options: {
    omitNotificationIds?: boolean;
    skipNotification?: boolean;
    continueAfterNotification?: boolean;
    progressAfterNotification?: boolean;
  } = {}
): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield {
        type: "assistant",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-agent",
              name: "Agent",
              input: {
                description: "Explore codebase structure",
                prompt: "Find files"
              }
            }
          ]
        }
      } as unknown as SDKMessage;
      yield {
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-agent",
              content:
                "Async agent launched successfully\nagentId: agent-1\noutput_file: /tmp/agent-1.output"
            }
          ]
        }
      } as unknown as SDKMessage;
      yield {
        type: "system",
        subtype: "task_started",
        task_id: "task-1",
        agent_id: "agent-1",
        description: "Explore codebase structure"
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      if (options.skipNotification) {
        return;
      }
      yield {
        type: "system",
        subtype: "task_notification",
        ...(options.omitNotificationIds ? {} : { task_id: "task-1" }),
        status: "completed",
        summary: "Found files"
      } as unknown as SDKMessage;
      if (options.progressAfterNotification) {
        yield {
          type: "system",
          subtype: "task_progress",
          task_id: "task-1",
          description: "Explore codebase structure"
        } as unknown as SDKMessage;
      }
      if (!options.continueAfterNotification) {
        return;
      }
      yield {
        type: "assistant",
        uuid: "assistant-2",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Continuing after child agent."
            }
          ]
        }
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakeTimedOutDelegatedTaskQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  onInterrupt: () => void
): AsyncIterable<SDKMessage> & {
  interrupt: () => Promise<void>;
  close: () => void;
} {
  let releaseWait: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    releaseWait = resolve;
  });
  return {
    async *[Symbol.asyncIterator]() {
      yield* fakeDelegatedTaskQuery(prompt);
      await wait;
    },
    async interrupt() {
      onInterrupt();
      releaseWait();
    },
    close() {
      releaseWait();
    }
  };
}

export function fakeGuidedDelegatedContinuationQuery(
  prompt: AsyncIterable<SDKUserMessage>
): AsyncIterable<SDKMessage> & { close: () => void } {
  return {
    async *[Symbol.asyncIterator]() {
      yield* fakeDelegatedTaskQuery(prompt);
      const guidance = await prompt[Symbol.asyncIterator]().next();
      if (guidance.done) {
        return;
      }
      yield {
        ...guidance.value,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield {
        type: "assistant",
        uuid: "assistant-guided-continuation",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Guided continuation." }]
        }
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  };
}

export function fakeDelegatedAssistantParentQuery({
  prompt
}: {
  prompt: AsyncIterable<SDKUserMessage>;
}): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield delegatedAgentToolUse("toolu-agent", "Child task");
      yield delegatedAgentToolResult("toolu-agent", "agent-1");
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      // Mid-run child streaming: assistant messages tagged with the parent
      // tool use id arrive while the child is still working and must not
      // settle the delegated task.
      yield {
        type: "assistant",
        uuid: "assistant-child-1",
        parent_tool_use_id: "toolu-agent",
        session_id: "provider-session-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Still working on the child task" }]
        }
      } as unknown as SDKMessage;
      yield {
        type: "system",
        subtype: "task_progress",
        task_id: "agent-1",
        description: "Child task"
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        parent_tool_use_id: "toolu-agent",
        result: "Child result ready"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakeSimpleResultQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  result: Record<string, unknown> = {}
): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        ...result
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakeContextUsageQuery(
  prompt: AsyncIterable<SDKUserMessage>
): AsyncIterable<SDKMessage> & {
  getContextUsage: () => Promise<unknown>;
  close: () => void;
} {
  const query = {
    contextUsage: {
      totalTokens: 36_092,
      maxTokens: 200_000,
      rawMaxTokens: 1_000_000
    },
    async *[Symbol.asyncIterator]() {
      const firstPrompt = await prompt[Symbol.asyncIterator]().next();
      const promptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      yield {
        ...promptMessage,
        uuid: promptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        num_turns: 5,
        usage: {
          input_tokens: 26_694,
          output_tokens: 473,
          cache_read_input_tokens: 110_952,
          cache_creation_input_tokens: 27_961,
          iterations: null
        },
        modelUsage: {
          "claude-sonnet-5": {
            inputTokens: 12,
            outputTokens: 3,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0,
            contextWindow: 1_000_000,
            maxOutputTokens: 64_000
          }
        }
      } as unknown as SDKMessage;
    },
    async getContextUsage() {
      return this.contextUsage;
    },
    close() {}
  };
  return query;
}
