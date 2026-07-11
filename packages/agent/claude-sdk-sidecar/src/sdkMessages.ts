import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { numberValue, recordValue } from "./normalizer.ts";
import { stringValue } from "./runtimeValues.ts";

export function mergeToolResult(
  result: Record<string, unknown>,
  hookResult: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!hookResult) {
    return result;
  }
  return {
    ...result,
    ...hookResult,
    _meta: {
      ...(recordValue(result._meta) ?? {}),
      ...(recordValue(hookResult._meta) ?? {})
    }
  };
}

export function isDiffToolResponse(
  value: Record<string, unknown> | undefined
): value is Record<string, unknown> {
  return Boolean(
    value &&
    stringValue(value.filePath) &&
    Array.isArray(value.structuredPatch) &&
    value.structuredPatch.length > 0
  );
}

export function readSDKSessionID(message: SDKMessage): string {
  const value = (message as { session_id?: unknown }).session_id;
  return typeof value === "string" ? value : "";
}

export function readSDKMessageUuid(message: SDKMessage): string {
  const value = (message as { uuid?: unknown }).uuid;
  return typeof value === "string" ? value : "";
}

export function readSDKAssistantUuid(message: SDKMessage): string {
  if (message.type !== "assistant") {
    return "";
  }
  return readSDKMessageUuid(message);
}

export function readSDKAssistantMessageID(message: SDKMessage): string {
  if (message.type !== "assistant") {
    return "";
  }
  const inner = (message as { message?: unknown }).message;
  const record = recordValue(inner);
  return stringValue(record?.id);
}

export function readSDKParentToolUseID(message: SDKMessage): string {
  const value = (message as { parent_tool_use_id?: unknown })
    .parent_tool_use_id;
  return typeof value === "string" ? value.trim() : "";
}

export function taskStepFromToolPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: stringValue(payload.toolCallId) || stringValue(payload.callId),
    toolUseId: stringValue(payload.toolCallId) || stringValue(payload.callId),
    toolName: stringValue(payload.toolName),
    name: stringValue(payload.name) || stringValue(payload.toolName),
    callType: stringValue(payload.callType),
    status: stringValue(payload.status),
    toolInput: recordValue(payload.input),
    toolResult: recordValue(payload.output),
    toolError: recordValue(payload.error),
    payload: {
      input: recordValue(payload.input),
      output: recordValue(payload.output),
      error: recordValue(payload.error),
      content: Array.isArray(payload.content) ? payload.content : undefined,
      locations: Array.isArray(payload.locations)
        ? payload.locations
        : undefined
    },
    metadata: recordValue(payload.metadata),
    content: Array.isArray(payload.content) ? payload.content : undefined,
    locations: Array.isArray(payload.locations) ? payload.locations : undefined
  };
}

export function normalizeResumeCursor(
  value: Record<string, unknown> | undefined,
  providerSessionId: string
): Record<string, unknown> | undefined {
  const resume = stringValue(value?.resume) || providerSessionId;
  if (!resume) {
    return undefined;
  }
  return {
    kind: "claude-agent-sdk",
    version: 1,
    resume,
    ...(stringValue(value?.resumeSessionAt)
      ? { resumeSessionAt: stringValue(value?.resumeSessionAt) }
      : {}),
    turnCount: numberValue(value?.turnCount)
  };
}

export function abortError(): Error {
  const error = new Error("Claude SDK turn interrupted");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.includes("interrupted"))
  );
}

export function contextWindowTokensFromModelUsage(value: unknown): number {
  if (Array.isArray(value)) {
    for (const item of value) {
      const tokens = contextWindowTokensFromModelUsage(item);
      if (tokens > 0) {
        return tokens;
      }
    }
    return 0;
  }
  const record = recordValue(value);
  if (!record) {
    return 0;
  }
  for (const key of [
    "maxTokens",
    "max_tokens",
    "contextWindowTokens",
    "context_window_tokens",
    "contextWindow",
    "modelContextWindow",
    "model_context_window",
    "size",
    "limit",
    "max"
  ]) {
    const tokens = numberValue(record[key]);
    if (tokens > 0) {
      return tokens;
    }
  }
  for (const nested of Object.values(record)) {
    if (typeof nested !== "object" || nested === null) {
      continue;
    }
    const tokens = contextWindowTokensFromModelUsage(nested);
    if (tokens > 0) {
      return tokens;
    }
  }
  return 0;
}

export function isCompactCommandPrompt(value: string): boolean {
  const prompt = value.trim().toLowerCase();
  return prompt === "/compact" || prompt.startsWith("/compact ");
}
