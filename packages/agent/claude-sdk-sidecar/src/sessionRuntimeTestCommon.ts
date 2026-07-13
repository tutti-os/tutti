import type {
  Options as ClaudeQueryOptions,
  SDKMessage
} from "@anthropic-ai/claude-agent-sdk";

export type TestCanUseToolOptions = Parameters<
  NonNullable<ClaudeQueryOptions["canUseTool"]>
>[2];

export function testCanUseToolOptions(input: {
  requestId: string;
  toolUseID: string;
}): TestCanUseToolOptions {
  return {
    signal: new AbortController().signal,
    requestId: input.requestId,
    toolUseID: input.toolUseID
  } as TestCanUseToolOptions;
}

export function delegatedAgentToolUse(
  id: string,
  description: string
): SDKMessage {
  return {
    type: "assistant",
    uuid: `${id}-assistant`,
    parent_tool_use_id: null,
    session_id: "provider-session-1",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name: "Agent",
          input: {
            description,
            prompt: description
          }
        }
      ]
    }
  } as unknown as SDKMessage;
}

export function delegatedAgentToolResult(
  id: string,
  agentId: string
): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    session_id: "provider-session-1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: `Async agent launched successfully\nagentId: ${agentId}\noutput_file: /tmp/${agentId}.output`
        }
      ]
    }
  } as unknown as SDKMessage;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function consolidatedAssistant(
  uuid: string,
  id: string,
  content: Array<Record<string, unknown>>
): SDKMessage {
  return {
    type: "assistant",
    uuid,
    parent_tool_use_id: null,
    session_id: "provider-session-1",
    message: {
      id,
      role: "assistant",
      content
    }
  } as unknown as SDKMessage;
}
