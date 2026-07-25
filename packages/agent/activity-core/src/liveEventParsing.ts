import { cloneJSONValue } from "./activityValueParsing.ts";
import type { AgentActivityMessageDeltaEvent } from "./message.types.ts";

/**
 * Cleans the transport-shaped public WebSocket payload into the strict live
 * message contract consumed by the optimistic overlay.
 */
export function parseAgentActivityMessageDeltaEvent(
  value: unknown
): AgentActivityMessageDeltaEvent | null {
  const event = recordValue(value);
  const data = recordValue(event?.data);
  if (
    event?.eventType !== "message_delta" ||
    !data ||
    !nonEmptyString(event.workspaceId) ||
    !nonEmptyString(event.agentSessionId) ||
    data.workspaceId !== event.workspaceId ||
    data.agentSessionId !== event.agentSessionId ||
    !nonEmptyString(data.messageId) ||
    !nonEmptyString(data.turnId) ||
    !nonEmptyString(data.role) ||
    !nonEmptyString(data.kind) ||
    !positiveSafeInteger(data.occurredAtUnixMs)
  ) {
    return null;
  }
  const content = parseContentOperation(data.content);
  if (data.content !== undefined && !content) {
    return null;
  }
  const toolOutput = parseToolOutputOperation(data.toolOutput);
  if (
    (data.toolOutput !== undefined && !toolOutput) ||
    (toolOutput && data.kind !== "tool_call")
  ) {
    return null;
  }
  const payloadSet =
    data.payloadSet === undefined ? undefined : recordValue(data.payloadSet);
  if (data.payloadSet !== undefined && !payloadSet) {
    return null;
  }
  const payloadUnset = stringArray(data.payloadUnset);
  if (data.payloadUnset !== undefined && !payloadUnset) {
    return null;
  }
  const semantics =
    data.semantics === undefined ? undefined : recordValue(data.semantics);
  if (data.semantics !== undefined && !semantics) {
    return null;
  }
  if (
    (data.status !== undefined && typeof data.status !== "string") ||
    !optionalNonNegativeSafeInteger(data.startedAtUnixMs) ||
    !optionalNonNegativeSafeInteger(data.completedAtUnixMs)
  ) {
    return null;
  }
  if (
    !content &&
    !toolOutput &&
    !payloadSet &&
    !payloadUnset &&
    data.status === undefined &&
    !semantics &&
    data.startedAtUnixMs === undefined &&
    data.completedAtUnixMs === undefined
  ) {
    return null;
  }
  return {
    workspaceId: event.workspaceId,
    agentSessionId: event.agentSessionId,
    eventType: "message_delta",
    data: {
      workspaceId: data.workspaceId,
      agentSessionId: data.agentSessionId,
      messageId: data.messageId,
      turnId: data.turnId,
      role: data.role,
      kind: data.kind,
      occurredAtUnixMs: data.occurredAtUnixMs,
      ...(content ? { content } : {}),
      ...(toolOutput ? { toolOutput } : {}),
      ...(payloadSet
        ? {
            payloadSet: cloneJSONValue(payloadSet) as Record<string, unknown>
          }
        : {}),
      ...(payloadUnset ? { payloadUnset } : {}),
      ...(typeof data.status === "string" ? { status: data.status } : {}),
      ...(semantics
        ? {
            semantics: cloneJSONValue(
              semantics
            ) as AgentActivityMessageDeltaEvent["data"]["semantics"]
          }
        : {}),
      ...(typeof data.startedAtUnixMs === "number"
        ? { startedAtUnixMs: data.startedAtUnixMs }
        : {}),
      ...(typeof data.completedAtUnixMs === "number"
        ? { completedAtUnixMs: data.completedAtUnixMs }
        : {})
    }
  };
}

function parseToolOutputOperation(
  value: unknown
): AgentActivityMessageDeltaEvent["data"]["toolOutput"] | null {
  if (value === undefined) return null;
  const operation = recordValue(value);
  if (!operation || typeof operation.text !== "string") return null;
  if (operation.operation === "set" && operation.offsetBytes === undefined) {
    return { operation: "set", text: operation.text };
  }
  if (
    operation.operation === "append_text" &&
    operation.text.length > 0 &&
    nonNegativeSafeInteger(operation.offsetBytes)
  ) {
    return {
      operation: "append_text",
      text: operation.text,
      offsetBytes: operation.offsetBytes
    };
  }
  return null;
}

function parseContentOperation(
  value: unknown
): AgentActivityMessageDeltaEvent["data"]["content"] | null {
  if (value === undefined) return null;
  const operation = recordValue(value);
  if (!operation) return null;
  if (
    operation.operation === "append_text" &&
    typeof operation.text === "string"
  ) {
    return { operation: "append_text", text: operation.text };
  }
  if (
    operation.operation === "set" &&
    Object.prototype.hasOwnProperty.call(operation, "value")
  ) {
    return {
      operation: "set",
      value: cloneJSONValue(operation.value)
    };
  }
  return null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalNonNegativeSafeInteger(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function stringArray(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => !nonEmptyString(item))
  ) {
    return null;
  }
  return [...new Set(value)];
}
