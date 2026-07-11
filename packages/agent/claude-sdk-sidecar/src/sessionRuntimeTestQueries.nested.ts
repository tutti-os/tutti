import assert from "node:assert/strict";
import type {
  Options as ClaudeQueryOptions,
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import {
  delegatedAgentToolResult,
  delegatedAgentToolUse,
  testCanUseToolOptions
} from "./sessionRuntimeTestCommon.ts";

export function fakeNestedDelegatedLaunchQuery({
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
      yield delegatedAgentToolUse("toolu-parent", "Parent task");
      yield delegatedAgentToolResult("toolu-parent", "agent-parent");
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      // Child stream: the child agent launches a grandchild Task after the
      // launching turn already settled.
      yield nestedAssistantToolUse(
        "toolu-parent",
        "toolu-child",
        "Grandchild task"
      );
      yield nestedAgentLaunchResult(
        "toolu-parent",
        "toolu-child",
        "agent-child"
      );
      yield userTaskNotification("agent-child", "toolu-child");
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakeNestedLaunchWithoutToolUseQuery({
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
      yield delegatedAgentToolUse("toolu-parent", "Parent task");
      yield delegatedAgentToolResult("toolu-parent", "agent-parent");
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      // Only the launch result streams through; the grandchild tool_use block
      // was never observed, so the local tool name is unknown.
      yield nestedAgentLaunchResult(
        "toolu-parent",
        "toolu-child",
        "agent-child"
      );
      yield userTaskNotification("agent-child", "toolu-child");
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakeNestedApprovalQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  options: ClaudeQueryOptions,
  onPermissionResult: (result: unknown) => void
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
      yield delegatedAgentToolUse("toolu-parent", "Parent task");
      yield delegatedAgentToolResult("toolu-parent", "agent-parent");
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      yield {
        type: "system",
        subtype: "task_notification",
        task_id: "agent-parent",
        status: "completed",
        summary: "Parent done"
      } as unknown as SDKMessage;
      // A grandchild tool runs after the parent task completed; its approval
      // must still resolve a turn id or the approval card never surfaces.
      const result = await options.canUseTool?.(
        "Bash",
        { command: "ls" },
        testCanUseToolOptions({
          requestId: "request-nested-bash",
          toolUseID: "toolu-nested-bash"
        })
      );
      onPermissionResult(result);
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakeNestedDeferredParentCompletionQuery({
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
      yield delegatedAgentToolUse("toolu-parent", "Parent task");
      yield delegatedAgentToolResult("toolu-parent", "agent-parent");
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      yield nestedAssistantToolUse(
        "toolu-parent",
        "toolu-child",
        "Grandchild task"
      );
      yield nestedAgentLaunchResult(
        "toolu-parent",
        "toolu-child",
        "agent-child"
      );
      // The child ends its own turn while the grandchild is still running;
      // this must not settle the child's delegated task yet.
      yield nestedEndTurnAssistant(
        "toolu-parent",
        "assistant-premature-end",
        "All grandchildren launched."
      );
      yield userTaskNotification("agent-child", "toolu-child");
      yield nestedEndTurnAssistant(
        "toolu-parent",
        "assistant-final-end",
        "Parent finished."
      );
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakeNestedToolUseAndEndTurnQuery({
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
      yield delegatedAgentToolUse("toolu-parent", "Parent task");
      yield delegatedAgentToolResult("toolu-parent", "agent-parent");
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
      yield nestedAssistantToolUseWithEndTurn(
        "toolu-parent",
        "toolu-child",
        "Grandchild task",
        "Launched grandchild."
      );
      yield nestedAgentLaunchResult(
        "toolu-parent",
        "toolu-child",
        "agent-child"
      );
      yield userTaskNotification("agent-child", "toolu-child");
      yield nestedEndTurnAssistant(
        "toolu-parent",
        "assistant-final-end",
        "Parent finished."
      );
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function nestedAssistantToolUse(
  parentToolUseId: string,
  id: string,
  description: string
): SDKMessage {
  return {
    type: "assistant",
    uuid: `${id}-nested-assistant`,
    parent_tool_use_id: parentToolUseId,
    session_id: "provider-session-1",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name: "Task",
          input: {
            description,
            prompt: description
          }
        }
      ]
    }
  } as unknown as SDKMessage;
}

export function nestedAssistantToolUseWithEndTurn(
  parentToolUseId: string,
  id: string,
  description: string,
  text: string
): SDKMessage {
  return {
    type: "assistant",
    uuid: `${id}-nested-end-turn-assistant`,
    parent_tool_use_id: parentToolUseId,
    session_id: "provider-session-1",
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [
        { type: "text", text },
        {
          type: "tool_use",
          id,
          name: "Task",
          input: {
            description,
            prompt: description
          }
        }
      ]
    }
  } as unknown as SDKMessage;
}

export function nestedAgentLaunchResult(
  parentToolUseId: string,
  toolUseId: string,
  agentId: string
): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: parentToolUseId,
    session_id: "provider-session-1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: `Async agent launched successfully\nagentId: ${agentId}\noutput_file: /tmp/${agentId}.output`
        }
      ]
    }
  } as unknown as SDKMessage;
}

export function nestedEndTurnAssistant(
  parentToolUseId: string,
  uuid: string,
  text: string
): SDKMessage {
  return {
    type: "assistant",
    uuid,
    parent_tool_use_id: parentToolUseId,
    session_id: "provider-session-1",
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text }]
    }
  } as unknown as SDKMessage;
}

export function userTaskNotification(
  taskId: string,
  toolUseId: string
): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    session_id: "provider-session-1",
    message: {
      role: "user",
      content: `<task-notification>
<task-id>${taskId}</task-id>
<tool-use-id>${toolUseId}</tool-use-id>
<status>completed</status>
<summary>done</summary>
</task-notification>`
    }
  } as unknown as SDKMessage;
}

export async function waitForEvent(
  events: Array<{ type: string }>,
  type: string
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (events.some((event) => event.type === type)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(
    `timed out waiting for ${type}; events=${JSON.stringify(events)}`
  );
}
