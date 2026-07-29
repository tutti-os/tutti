import type {
  EngineExternalCommand,
  EngineIntent
} from "@tutti-os/agent-activity-core";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";

export type AgentSessionActivityEventKind = "effect" | "intent";

export interface AgentSessionActivityEvent {
  agentSessionId?: string;
  causedByEventId?: string;
  correlationId?: string;
  eventId: string;
  kind: AgentSessionActivityEventKind;
  occurredAtUnixMs: number;
  payload: Readonly<Record<string, unknown>>;
  schemaVersion: 3;
  scopeId: string;
  sequence: number;
  type: string;
}

export interface AppendAgentSessionActivityEventsInput {
  events: readonly AgentSessionActivityEvent[];
  recordingId: string;
}

export interface AgentSessionActivityEventAppender {
  append(input: AppendAgentSessionActivityEventsInput): Promise<void>;
}

export function createTuttidAgentSessionActivityEventAppender(input: {
  tuttidClient: Pick<TuttidClient, "appendAgentSessionRecordingActivityEvents">;
  workspaceId: string;
}): AgentSessionActivityEventAppender {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) throw new Error("workspaceId is required");
  return {
    async append({ events, recordingId }) {
      await input.tuttidClient.appendAgentSessionRecordingActivityEvents(
        workspaceId,
        recordingId,
        {
          events: events.map((event) => ({
            ...(event.agentSessionId
              ? { agentSessionId: event.agentSessionId }
              : {}),
            ...(event.causedByEventId
              ? { causedByEventId: event.causedByEventId }
              : {}),
            ...(event.correlationId
              ? { correlationId: event.correlationId }
              : {}),
            eventId: event.eventId,
            kind: event.kind,
            occurredAtUnixMs: event.occurredAtUnixMs,
            payload: { ...event.payload },
            type: event.type
          }))
        }
      );
    }
  };
}

export interface StartAgentSessionActivityEventRecordingInput {
  recordingId: string;
  scopeId: string;
}

interface ObservedCommand {
  agentSessionId?: string;
  causedByEventId?: string;
  command: EngineExternalCommand;
  correlationId?: string;
}

const replayableIntentTypes = new Set<EngineIntent["type"]>([
  "queue/enqueued",
  "queue/removed",
  "queue/resumed",
  "queue/sendNowRequested",
  "queue/suspended",
  "submit/canceled",
  "submit/requested"
]);

const replayableEffectTypes = new Set<EngineExternalCommand["type"]>([
  "queue/sendPrompt"
]);

export class AgentSessionActivityEventRecorder {
  private readonly appender: AgentSessionActivityEventAppender;
  private readonly maxBatchSize: number;
  private readonly nowUnixMs: () => number;
  private active: StartAgentSessionActivityEventRecordingInput | null = null;
  private sealed = false;
  private nextSequence = 1;
  private pending: AgentSessionActivityEvent[] = [];
  private flushInFlight: Promise<void> | null = null;
  private readonly eventIdByCorrelationId = new Map<string, string>();
  private readonly observedCommands = new Map<string, ObservedCommand>();

  constructor(input: {
    appender: AgentSessionActivityEventAppender;
    maxBatchSize?: number;
    nowUnixMs?: () => number;
  }) {
    this.appender = input.appender;
    this.maxBatchSize = Math.max(1, Math.floor(input.maxBatchSize ?? 256));
    this.nowUnixMs = input.nowUnixMs ?? Date.now;
  }

  start(input: StartAgentSessionActivityEventRecordingInput): void {
    const recordingId = input.recordingId.trim();
    const scopeId = input.scopeId.trim();
    if (!recordingId || !scopeId) {
      throw new Error("recordingId and scopeId are required");
    }
    if (this.active || this.pending.length > 0 || this.flushInFlight) {
      throw new Error("activity event recording is already active");
    }
    this.active = { recordingId, scopeId };
    this.sealed = false;
    this.nextSequence = 1;
    this.eventIdByCorrelationId.clear();
    this.observedCommands.clear();
  }

  observeCommand(command: EngineExternalCommand): void {
    if (!this.active || this.sealed || !replayableEffectTypes.has(command.type))
      return;
    const commandId = command.commandId.trim();
    if (!commandId) return;
    const correlationId = commandCorrelationId(command);
    this.observedCommands.set(commandId, {
      agentSessionId: commandAgentSessionId(command),
      causedByEventId:
        this.eventIdByCorrelationId.get(correlationId ?? "") ??
        this.eventIdByCorrelationId.get(commandId),
      command: cloneValue(command),
      ...(correlationId ? { correlationId } : {})
    });
  }

  observeIntent(intent: EngineIntent): void {
    if (!this.active || this.sealed) return;
    if (intent.type === "engine/commandResult") {
      this.recordEffect(intent);
      return;
    }
    if (!replayableIntentTypes.has(intent.type)) return;
    const correlationId = intentCorrelationId(intent);
    const event = this.appendEvent({
      agentSessionId: intentAgentSessionId(intent),
      ...(correlationId ? { correlationId } : {}),
      kind: "intent",
      payload: payloadWithoutCommonFields(intent),
      type: intent.type
    });
    for (const candidate of intentCorrelationCandidates(intent)) {
      this.eventIdByCorrelationId.set(candidate, event.eventId);
    }
  }

  async flush(): Promise<void> {
    if (!this.active || this.pending.length === 0) return;
    if (this.flushInFlight) {
      await this.flushInFlight;
      if (this.pending.length > 0) {
        await this.flush();
      }
      return;
    }
    const active = this.active;
    const batchSize = Math.min(this.pending.length, this.maxBatchSize);
    const events = this.pending.slice(0, batchSize);
    const operation = this.appender.append({
      events,
      recordingId: active.recordingId
    });
    this.flushInFlight = operation;
    try {
      await operation;
      this.pending.splice(0, batchSize);
    } finally {
      this.flushInFlight = null;
    }
    if (this.pending.length > 0) {
      await this.flush();
    }
  }

  async seal(recordingId?: string): Promise<void> {
    if (!this.active) return;
    this.assertActiveRecording(recordingId);
    this.sealed = true;
    await this.flush();
    this.active = null;
    this.eventIdByCorrelationId.clear();
    this.observedCommands.clear();
  }

  discard(recordingId?: string): void {
    if (this.active) this.assertActiveRecording(recordingId);
    this.active = null;
    this.sealed = false;
    this.pending = [];
    this.eventIdByCorrelationId.clear();
    this.observedCommands.clear();
  }

  private assertActiveRecording(recordingId?: string): void {
    const expected = recordingId?.trim();
    if (expected && this.active?.recordingId !== expected) {
      throw new Error("activity event recording id does not match");
    }
  }

  private recordEffect(
    intent: Extract<EngineIntent, { type: "engine/commandResult" }>
  ): void {
    const command = this.observedCommands.get(intent.commandId);
    if (!command || command.command.type !== intent.commandType) return;
    this.observedCommands.delete(intent.commandId);
    if (!command.causedByEventId) return;
    const payload = {
      ...payloadWithoutCommonFields(command.command),
      outcome: intent.outcome,
      ...(intent.errorCode ? { errorCode: intent.errorCode } : {}),
      ...(intent.errorReason ? { errorReason: intent.errorReason } : {}),
      ...(intent.errorMessage ? { errorMessage: intent.errorMessage } : {}),
      ...(intent.value !== undefined
        ? { result: cloneValue(intent.value) }
        : {})
    };
    this.appendEvent({
      agentSessionId: command.agentSessionId,
      causedByEventId: command.causedByEventId,
      correlationId: intent.correlationId ?? command.correlationId,
      kind: "effect",
      payload,
      type: intent.commandType
    });
  }

  private appendEvent(
    input: Omit<
      AgentSessionActivityEvent,
      "eventId" | "occurredAtUnixMs" | "schemaVersion" | "scopeId" | "sequence"
    >
  ): AgentSessionActivityEvent {
    const active = this.active;
    if (!active) {
      throw new Error("activity event recording is not active");
    }
    const sequence = this.nextSequence++;
    const event: AgentSessionActivityEvent = {
      ...input,
      eventId: `${active.recordingId}:activity:${sequence}`,
      occurredAtUnixMs: this.nowUnixMs(),
      schemaVersion: 3,
      scopeId: active.scopeId,
      sequence
    };
    this.pending.push(event);
    return event;
  }
}

function payloadWithoutCommonFields(
  value: object
): Readonly<Record<string, unknown>> {
  const payload = cloneValue(value) as Record<string, unknown>;
  delete payload.agentSessionId;
  delete payload.commandId;
  delete payload.correlationId;
  delete payload.type;
  delete payload.workspaceId;
  return payload;
}

function commandCorrelationId(command: EngineExternalCommand): string | null {
  return "correlationId" in command && typeof command.correlationId === "string"
    ? command.correlationId.trim() || null
    : null;
}

function commandAgentSessionId(
  command: EngineExternalCommand
): string | undefined {
  return "agentSessionId" in command &&
    typeof command.agentSessionId === "string"
    ? command.agentSessionId.trim() || undefined
    : undefined;
}

function intentAgentSessionId(intent: EngineIntent): string | undefined {
  return "agentSessionId" in intent && typeof intent.agentSessionId === "string"
    ? intent.agentSessionId.trim() || undefined
    : undefined;
}

function intentCorrelationId(intent: EngineIntent): string | undefined {
  for (const key of [
    "clientSubmitId",
    "idempotencyKey",
    "commandId",
    "promptId",
    "requestId"
  ] as const) {
    const candidate = intent[key as keyof EngineIntent];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function intentCorrelationCandidates(intent: EngineIntent): readonly string[] {
  const candidates = new Set<string>();
  for (const key of [
    "clientSubmitId",
    "idempotencyKey",
    "commandId",
    "promptId",
    "requestId"
  ] as const) {
    const candidate = intent[key as keyof EngineIntent];
    if (typeof candidate === "string" && candidate.trim()) {
      candidates.add(candidate.trim());
    }
  }
  if (
    "prompt" in intent &&
    intent.prompt &&
    typeof intent.prompt === "object"
  ) {
    const prompt = intent.prompt as { clientSubmitId?: unknown; id?: unknown };
    for (const candidate of [prompt.clientSubmitId, prompt.id]) {
      if (typeof candidate === "string" && candidate.trim()) {
        candidates.add(candidate.trim());
      }
    }
  }
  return [...candidates];
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
