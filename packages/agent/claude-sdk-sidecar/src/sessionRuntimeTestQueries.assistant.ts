import type {
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import { consolidatedAssistant } from "./sessionRuntimeTestCommon.ts";
import { fakeSimpleResultQuery } from "./sessionRuntimeTestQueries.delegated.ts";

export function fakeEarlyConsolidatedAssistantQuery(
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
        type: "stream_event",
        uuid: "stream-message-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "message_start",
          message: { id: "msg-early" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_start",
          index: 5,
          content_block: { type: "text", text: "" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-delta",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_delta",
          index: 5,
          delta: { type: "text_delta", text: "Done." }
        }
      } as unknown as SDKMessage;
      yield consolidatedAssistant("assistant-early", "msg-early", [
        { type: "text", text: "Done." }
      ]);
      yield {
        type: "stream_event",
        uuid: "stream-text-stop",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: { type: "content_block_stop", index: 5 }
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakePartialStreamAssistantQuery(
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
        type: "stream_event",
        uuid: "stream-message-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "message_start",
          message: { id: "msg-partial" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_start",
          index: 2,
          content_block: { type: "text", text: "" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-delta",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_delta",
          index: 2,
          delta: { type: "text_delta", text: "hello" }
        }
      } as unknown as SDKMessage;
      yield consolidatedAssistant("assistant-partial", "msg-partial", [
        { type: "text", text: "hello world" }
      ]);
      yield {
        type: "stream_event",
        uuid: "stream-text-stop",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: { type: "content_block_stop", index: 2 }
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakeNonStreamingAssistantQuery(
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
      yield consolidatedAssistant("assistant-fallback", "msg-fallback", [
        { type: "text", text: "Offline answer." }
      ]);
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakeInterleavedAssistantQuery(
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
        type: "stream_event",
        uuid: "stream-message-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "message_start",
          message: { id: "msg-interleaved" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-thinking-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-thinking-delta",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Need a skill." }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-thinking-stop",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: { type: "content_block_stop", index: 0 }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-1-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_start",
          index: 4,
          content_block: { type: "text", text: "" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-1-delta",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_delta",
          index: 4,
          delta: { type: "text_delta", text: "Before tool." }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-1-stop",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: { type: "content_block_stop", index: 4 }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_start",
          index: 8,
          content_block: {
            type: "tool_use",
            id: "toolu-interleaved",
            name: "Grep",
            input: { pattern: "assistant" }
          }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: { type: "content_block_stop", index: 8 }
      } as unknown as SDKMessage;
      yield {
        type: "user",
        uuid: "user-tool-result",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-interleaved",
              content: "result"
            }
          ]
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-2-start",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_start",
          index: 12,
          content_block: { type: "text", text: "" }
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-2-delta",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: {
          type: "content_block_delta",
          index: 12,
          delta: { type: "text_delta", text: "After tool." }
        }
      } as unknown as SDKMessage;
      yield {
        type: "assistant",
        uuid: "assistant-interleaved",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        message: {
          id: "msg-interleaved",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Need a skill." },
            { type: "text", text: "Before tool." },
            {
              type: "tool_use",
              id: "toolu-interleaved",
              name: "Grep",
              input: { pattern: "assistant" }
            },
            { type: "text", text: "After tool." }
          ]
        }
      } as unknown as SDKMessage;
      yield {
        type: "stream_event",
        uuid: "stream-text-2-stop",
        parent_tool_use_id: null,
        session_id: "provider-session-1",
        event: { type: "content_block_stop", index: 12 }
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success"
      } as unknown as SDKMessage;
    },
    close() {}
  } as AsyncIterable<SDKMessage>;
}

export function fakeQueryWithInitializationModels(
  prompt: AsyncIterable<SDKUserMessage>,
  models: Array<Record<string, unknown>>
): AsyncIterable<SDKMessage> & {
  initializationResult: () => Promise<unknown>;
  close: () => void;
} {
  return {
    async initializationResult() {
      return { models };
    },
    async *[Symbol.asyncIterator]() {
      yield* fakeSimpleResultQuery(prompt);
    },
    close() {}
  };
}
