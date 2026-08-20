import type {
  Options as ClaudeQueryOptions,
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import {
  consolidatedAssistant,
  delegatedAgentToolResult,
  delegatedAgentToolUse,
  isRecord
} from "./sessionRuntimeTestCommon.ts";
import { fakeDelegatedTaskQuery } from "./sessionRuntimeTestQueries.delegated.ts";

export function fakeGuidancePromptQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  prompts: string[],
  interrupts?: {
    count: number;
    wait?: Promise<void>;
    resultWait?: Promise<void>;
  }
): AsyncIterable<SDKMessage> & { interrupt: () => Promise<void> } {
  let interrupted = false;
  return {
    async interrupt() {
      if (interrupts) {
        interrupts.count += 1;
        await interrupts.wait;
      }
      interrupted = true;
    },
    async *[Symbol.asyncIterator]() {
      const iterator = prompt[Symbol.asyncIterator]();
      const firstPrompt = await iterator.next();
      const firstPromptMessage = firstPrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      prompts.push(userPromptText(firstPromptMessage));
      yield {
        ...firstPromptMessage,
        uuid: firstPromptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;

      // guide() interrupts then enqueues; the next prompt read wakes after
      // interrupt, so emit the real Claude abort result before the steer text.
      const guidancePrompt = await iterator.next();
      if (interrupted) {
        await interrupts?.resultWait;
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "interrupted"
        } as unknown as SDKMessage;
      }
      const guidancePromptMessage = guidancePrompt.value as SDKUserMessage & {
        uuid?: string;
      };
      prompts.push(userPromptText(guidancePromptMessage));
      yield {
        ...guidancePromptMessage,
        uuid: guidancePromptMessage.uuid,
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1"
      } as SDKMessage;
      yield consolidatedAssistant("assistant-guided", "msg-guided", [
        { type: "text", text: "Guided response" }
      ]);
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage> & { interrupt: () => Promise<void> };
}

export function userPromptText(message: SDKUserMessage): string {
  const content = (message as { message?: { content?: unknown } }).message
    ?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? block.text
        : ""
    )
    .join("");
}

export function fakeDeferredContextUsageQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  contextUsageResolvers: Array<(value: unknown) => void>
): AsyncIterable<SDKMessage> & {
  getContextUsage: () => Promise<unknown>;
  close: () => void;
} {
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = prompt[Symbol.asyncIterator]();
      for (let index = 0; index < 2; index += 1) {
        const nextPrompt = await iterator.next();
        const promptMessage = nextPrompt.value as SDKUserMessage & {
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
          usage: {
            input_tokens: 120,
            output_tokens: 8,
            cache_read_input_tokens: 72,
            cache_creation_input_tokens: 0
          }
        } as unknown as SDKMessage;
      }
    },
    getContextUsage() {
      return new Promise((resolve) => contextUsageResolvers.push(resolve));
    },
    close() {}
  };
}

export function fakeCompactBoundaryQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  options: { boundaryAfterResult?: boolean } = {}
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
      if (options.boundaryAfterResult) {
        yield {
          type: "result",
          subtype: "success"
        } as unknown as SDKMessage;
      }
      yield {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          pre_tokens: 2400,
          post_tokens: 800
        }
      } as unknown as SDKMessage;
      if (options.boundaryAfterResult) {
        return;
      }
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

// Mirrors the real Claude Code sequence observed for a manual /compact: a
// `status`/`compact_result: "success"` system message reports completion with
// no accompanying `compact_boundary` message, so the only way to learn the
// post-compaction size is the `getContextUsage()` snapshot.
export function fakeStatusOnlyCompactQuery(
  prompt: AsyncIterable<SDKUserMessage>
): AsyncIterable<SDKMessage> & {
  getContextUsage: () => Promise<unknown>;
  close: () => void;
} {
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
        type: "system",
        subtype: "status",
        status: "compacting"
      } as unknown as SDKMessage;
      yield {
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "success"
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    async getContextUsage() {
      return {
        totalTokens: 4_061,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000
      };
    },
    close() {}
  };
}

export function fakeFailedCompactQuery(
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
      yield {
        type: "system",
        subtype: "status",
        status: "compacting"
      } as unknown as SDKMessage;
      yield {
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "failed",
        compact_error: "Not enough messages to compact."
      } as unknown as SDKMessage;
      yield consolidatedAssistant("assistant-compact-failed", "msg-compact", [
        { type: "text", text: "Not enough messages to compact." }
      ]);
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

// Claude Code 2.1.x often finishes a successful manual /compact with only a
// result (plus an on-disk compact_boundary that never reaches the query
// iterator). The progress banner must come from selectCommand, and the daemon
// settles it when turn_completed arrives.
export function fakeSilentCompactQuery(
  prompt: AsyncIterable<SDKUserMessage>
): AsyncIterable<SDKMessage> & {
  getContextUsage: () => Promise<unknown>;
  close: () => void;
} {
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
        subtype: "success"
      } as unknown as SDKMessage;
    },
    async getContextUsage() {
      return {
        totalTokens: 1_990,
        maxTokens: 200_000,
        rawMaxTokens: 200_000
      };
    },
    close() {}
  };
}

// Mirrors Claude Code 2.1.x compact failure: local_command stdout instead of
// status/compact_result, with a successful result subtype.
export function fakeLocalCommandFailedCompactQuery(
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
      yield {
        type: "system",
        subtype: "local_command",
        content:
          "<local-command-stdout>Not enough messages to compact.</local-command-stdout>"
      } as unknown as SDKMessage;
      yield consolidatedAssistant("assistant-compact-failed", "msg-compact", [
        { type: "text", text: "Not enough messages to compact." }
      ]);
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakePermissionCheckQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  options: ClaudeQueryOptions,
  check: (options: ClaudeQueryOptions) => Promise<void>
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
      await check(options);
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakeConcurrentDelegatedTaskCreatedHookQuery({
  prompt,
  options
}: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: unknown;
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
      yield delegatedAgentToolUse("toolu-agent-1", "First task");
      yield delegatedAgentToolResult("toolu-agent-1", "agent-1");
      await emitTestHooks(options, "TaskCreated", {
        hook_event_name: "TaskCreated",
        task_id: "task-2",
        task_subject: "Second task",
        task_description: "Second task"
      });
      yield delegatedAgentToolUse("toolu-agent-2", "Second task");
      yield delegatedAgentToolResult("toolu-agent-2", "agent-2");
      yield {
        type: "system",
        subtype: "task_started",
        task_id: "task-2",
        agent_id: "agent-2",
        description: "Second task"
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      yield {
        type: "system",
        subtype: "task_notification",
        task_id: "task-2",
        status: "completed",
        summary: "Second task complete"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakeDelegatedTaskCompletedHookQuery({
  prompt,
  options
}: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: unknown;
}): AsyncIterable<SDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* fakeDelegatedTaskQuery(prompt, { skipNotification: true });
      await emitTestHooks(options, "TaskCompleted", {
        hook_event_name: "TaskCompleted",
        task_id: "task-1",
        task_subject: "Explore codebase structure",
        task_description: "Explore codebase structure",
        summary: "Found files"
      });
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export type TestHookOptions = {
  hooks?: Record<
    string,
    Array<{
      hooks: unknown[];
    }>
  >;
};

export async function emitTestHooks(
  options: unknown,
  name: string,
  input: Record<string, unknown>
): Promise<void> {
  const hookOptions = options as TestHookOptions;
  for (const entry of hookOptions.hooks?.[name] ?? []) {
    for (const hook of entry.hooks) {
      await (hook as (value: unknown) => Promise<unknown>)(input);
    }
  }
}

export function fakeDelegatedTextOnlyCompletionQuery({
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
        type: "assistant",
        uuid: "assistant-child-final",
        parent_tool_use_id: "toolu-agent",
        session_id: "provider-session-1",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "7" }]
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

export function fakeFoldInTaskNotificationQuery({
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
        type: "attachment",
        uuid: "attachment-fold-in",
        session_id: "provider-session-1",
        attachment: {
          type: "queued_command",
          commandMode: "task-notification",
          prompt: `<task-notification>
<task-id>agent-1</task-id>
<tool-use-id>toolu-agent</tool-use-id>
<status>completed</status>
<summary>Agent "Child task" finished</summary>
<result>7</result>
</task-notification>`
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

export function fakeUserTaskNotificationQuery({
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
      yield {
        type: "user",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        message: {
          role: "user",
          content: `<task-notification>
<task-id>agent-1</task-id>
<tool-use-id>toolu-agent</tool-use-id>
<status>completed</status>
<summary>Agent "Child task" finished</summary>
</task-notification>`
        }
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}
