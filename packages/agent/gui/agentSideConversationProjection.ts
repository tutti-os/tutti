import type {
  AgentActivityEphemeralConversationEvent,
  AgentActivityEphemeralInteractionPatch,
  AgentActivityEphemeralStatePatch,
  AgentActivityEphemeralTurnPatch,
  AgentActivityMessage,
  AgentActivityMessageDeltaEvent
} from "@tutti-os/agent-activity-core";
import type { AgentSideUpdatedPayloadV1 } from "@tutti-os/event-protocol";

export function normalizeAgentSideConversationEvent(
  event: AgentSideUpdatedPayloadV1
): AgentActivityEphemeralConversationEvent {
  const identity = {
    workspaceId: event.workspaceId,
    agentSessionId: event.sideAgentSessionId,
    sourceAgentSessionId: event.sourceAgentSessionId,
    sequence: event.sequence
  };
  switch (event.eventType) {
    case "message_delta":
      return {
        ...identity,
        change: {
          kind: "message_delta",
          data: normalizeMessageDelta(event)
        }
      };
    case "message_update":
      return {
        ...identity,
        change: {
          kind: "message_update",
          message: normalizeMessageUpdate(event)
        }
      };
    case "state_patch":
      return {
        ...identity,
        change: {
          kind: "state_patch",
          patch: normalizeStatePatch(event.data)
        }
      };
    case "available_commands_update":
    case "config_options_update":
    case "session_audit":
      return { ...identity, change: { kind: "noop" } };
  }
}

function normalizeMessageDelta(
  event: Extract<AgentSideUpdatedPayloadV1, { eventType: "message_delta" }>
): AgentActivityMessageDeltaEvent["data"] {
  const data = record(event.data);
  const content = record(data.content);
  const toolOutput = record(data.toolOutput);
  const operation = text(content.operation);
  const contentValue =
    operation === "append_text"
      ? rawText(content.text) || rawText(content.value)
      : cloneValue(content.value ?? content.text ?? "");
  const normalizedContent: AgentActivityMessageDeltaEvent["data"]["content"] =
    operation === "append_text"
      ? { operation: "append_text", text: String(contentValue) }
      : operation === "set"
        ? { operation: "set", value: contentValue }
        : undefined;
  const toolOperation = text(toolOutput.operation);
  const normalizedToolOutput: AgentActivityMessageDeltaEvent["data"]["toolOutput"] =
    toolOperation === "append_text"
      ? {
          operation: "append_text",
          text: rawText(toolOutput.text),
          offsetBytes: positiveInteger(toolOutput.offsetBytes) ?? 0
        }
      : toolOperation === "set"
        ? { operation: "set", text: rawText(toolOutput.text) }
        : undefined;
  return {
    workspaceId: event.workspaceId,
    agentSessionId: event.sideAgentSessionId,
    messageId: text(data.messageId),
    turnId: text(data.turnId),
    role: normalizeRole(data.role),
    kind: normalizeMessageKind(data.kind, data.role),
    occurredAtUnixMs: positiveInteger(data.occurredAtUnixMs) ?? Date.now(),
    ...(normalizedContent ? { content: normalizedContent } : {}),
    ...(normalizedToolOutput ? { toolOutput: normalizedToolOutput } : {}),
    ...(recordOrNull(data.payloadSet)
      ? { payloadSet: record(data.payloadSet) }
      : {}),
    ...(Array.isArray(data.payloadUnset)
      ? {
          payloadUnset: data.payloadUnset.filter(
            (value): value is string => typeof value === "string"
          )
        }
      : {}),
    ...(text(data.status) ? { status: text(data.status) } : {}),
    ...(recordOrNull(data.semantics)
      ? {
          semantics: record(data.semantics)
        }
      : {}),
    ...(positiveInteger(data.startedAtUnixMs)
      ? { startedAtUnixMs: positiveInteger(data.startedAtUnixMs)! }
      : {}),
    ...(positiveInteger(data.completedAtUnixMs)
      ? { completedAtUnixMs: positiveInteger(data.completedAtUnixMs)! }
      : {})
  };
}

function normalizeMessageUpdate(
  event: Extract<AgentSideUpdatedPayloadV1, { eventType: "message_update" }>
): AgentActivityMessage {
  const data = record(event.data);
  const payload = record(data.payload);
  const contentDelta = rawText(data.contentDelta);
  if (contentDelta && typeof payload.text !== "string") {
    payload.text = contentDelta;
    payload.content = contentDelta;
  }
  const callId = text(data.callId);
  const parentCallId = text(data.parentCallId);
  const rootCallId = text(data.rootCallId);
  const title = text(data.title);
  if (callId && typeof payload.callId !== "string") payload.callId = callId;
  if (parentCallId && typeof payload.parentCallId !== "string") {
    payload.parentCallId = parentCallId;
  }
  if (rootCallId && typeof payload.rootCallId !== "string") {
    payload.rootCallId = rootCallId;
  }
  if (title && typeof payload.title !== "string") payload.title = title;
  return {
    workspaceId: event.workspaceId,
    agentSessionId: event.sideAgentSessionId,
    messageId: text(data.messageId),
    version: positiveInteger(data.seq) ?? event.sequence,
    turnId: text(data.turnId) || null,
    role: normalizeRole(data.role),
    kind: normalizeMessageKind(data.kind, data.role),
    ...(text(data.status) ? { status: text(data.status) } : {}),
    ...(recordOrNull(data.semantics)
      ? {
          semantics: record(data.semantics)
        }
      : {}),
    payload,
    occurredAtUnixMs: positiveInteger(data.occurredAtUnixMs) ?? Date.now(),
    ...(positiveInteger(data.startedAtUnixMs)
      ? { startedAtUnixMs: positiveInteger(data.startedAtUnixMs)! }
      : {}),
    ...(positiveInteger(data.completedAtUnixMs)
      ? { completedAtUnixMs: positiveInteger(data.completedAtUnixMs)! }
      : {})
  };
}

function normalizeStatePatch(
  dataInput: unknown
): AgentActivityEphemeralStatePatch {
  const data = record(dataInput);
  const turnLifecycle = record(data.turnLifecycle);
  const turn = normalizeTurnPatch(data.turn);
  const interaction = normalizeInteractionPatch(data.interactionTransition);
  return {
    provider: text(data.provider) || null,
    cwd: text(data.cwd) || null,
    title: text(data.title) || null,
    lifecycleStatus: text(data.lifecycleStatus) || null,
    currentPhase: text(data.currentPhase) || null,
    ...(Object.prototype.hasOwnProperty.call(turnLifecycle, "activeTurnId")
      ? {
          activeTurnId:
            typeof turnLifecycle.activeTurnId === "string"
              ? turnLifecycle.activeTurnId
              : null
        }
      : {}),
    turn,
    interaction,
    occurredAtUnixMs: positiveInteger(data.occurredAtUnixMs)
  };
}

function normalizeTurnPatch(
  value: unknown
): AgentActivityEphemeralTurnPatch | null {
  const turn = recordOrNull(value);
  const turnId = text(turn?.turnId);
  if (!turn || !turnId) return null;
  return {
    turnId,
    ...(Object.prototype.hasOwnProperty.call(turn, "activeTurnId")
      ? {
          activeTurnId:
            typeof turn.activeTurnId === "string" ? turn.activeTurnId : null
        }
      : {}),
    phase: text(turn.phase) || null,
    outcome: text(turn.outcome) || null,
    origin: text(turn.origin) || null,
    error: normalizeTurnError(turn.error),
    fileChanges: recordOrNull(turn.fileChanges),
    startedAtUnixMs: positiveInteger(turn.startedAtUnixMs),
    completedAtUnixMs: positiveInteger(turn.completedAtUnixMs),
    updatedAtUnixMs:
      positiveInteger(turn.updatedAtUnixMs) ??
      positiveInteger(turn.completedAtUnixMs) ??
      positiveInteger(turn.startedAtUnixMs)
  };
}

function normalizeInteractionPatch(
  value: unknown
): AgentActivityEphemeralInteractionPatch | null {
  const interaction = recordOrNull(value);
  const requestId = text(interaction?.requestId);
  const turnId = text(interaction?.turnId);
  if (!interaction || !requestId || !turnId) return null;
  const rawKind = text(interaction.kind);
  const kind: AgentActivityEphemeralInteractionPatch["kind"] =
    rawKind === "question"
      ? "question"
      : rawKind === "plan"
        ? "plan"
        : "approval";
  return {
    requestId,
    turnId,
    kind,
    status: text(interaction.status) || "pending",
    toolName: text(interaction.toolName) || null,
    input: recordOrNull(interaction.input),
    metadata: recordOrNull(interaction.metadata),
    output: recordOrNull(interaction.output),
    occurredAtUnixMs: positiveInteger(interaction.occurredAtUnixMs)
  };
}

function normalizeTurnError(
  value: unknown
): AgentActivityEphemeralTurnPatch["error"] {
  const error = recordOrNull(value);
  if (!error) return null;
  const message = text(error.message) || text(error.detail);
  if (!message) return null;
  return {
    ...(text(error.code) ? { code: text(error.code) } : {}),
    message
  };
}

function normalizeRole(value: unknown): string {
  const role = text(value).toLowerCase();
  if (role === "assistant_thinking") return "assistant";
  return role || "assistant";
}

function normalizeMessageKind(kindValue: unknown, roleValue: unknown): string {
  const kind = text(kindValue).toLowerCase();
  if (kind) return kind;
  return text(roleValue).toLowerCase() === "assistant_thinking"
    ? "reasoning"
    : "text";
}

function record(value: unknown): Record<string, unknown> {
  return recordOrNull(value) ?? {};
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? { ...(value as Record<string, unknown>) }
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function rawText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
