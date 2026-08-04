import type {
  EngineExternalCommand,
  EngineIntent
} from "@tutti-os/agent-activity-core";
import type {
  AgentSessionActivityEvent,
  AgentSessionActivityEventKind
} from "@tutti-os/agent-session-replay";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import {
  agentSessionReplayIntentAllowsEffect,
  agentSessionReplayIntentCorrelationCandidates,
  agentSessionReplayIntentCorrelationId,
  isEngineInternalAgentSessionReplayEffectCommand,
  isReplayableAgentSessionActivityEffectCommand,
  isReplayableAgentSessionActivityIntentType
} from "./agentSessionReplayInteractionContract.ts";

export { isReplayableAgentSessionActivityEffectCommand };

export type { AgentSessionActivityEvent, AgentSessionActivityEventKind };

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

export interface AgentSessionActivityRecordingDefect {
  commandId: string;
  commandType: string;
  correlationId: string | null;
  reason: "disallowed-effect" | "uncorrelated-command" | "unsettled-command";
}

interface ObservedCommand {
  agentSessionId?: string;
  causedByEventId?: string;
  command: EngineExternalCommand;
  correlationId?: string;
}

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
  private readonly correlationIdByEventId = new Map<string, string>();
  private readonly intentTypeByEventId = new Map<string, string>();
  private readonly observedCommands = new Map<string, ObservedCommand>();
  private readonly defectsByCommandId = new Map<
    string,
    AgentSessionActivityRecordingDefect
  >();

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
    this.clearCorrelationState();
  }

  observeCommand(command: EngineExternalCommand): void {
    if (
      !this.active ||
      this.sealed ||
      !isReplayableAgentSessionActivityEffectCommand(command.type)
    )
      return;
    const commandId = command.commandId.trim();
    if (!commandId) return;
    if (
      isEngineInternalAgentSessionReplayEffectCommand(command.type, commandId)
    )
      return;
    const correlationId = commandCorrelationId(command);
    const causedByEventId =
      this.eventIdByCorrelationId.get(correlationId ?? "") ??
      this.eventIdByCorrelationId.get(commandId);
    if (!causedByEventId) {
      // The product command path swallows recorder exceptions, so a broken
      // correlation is accumulated as a defect and fails seal() instead.
      this.registerDefect(command, commandId, "uncorrelated-command");
    } else {
      const causeIntentType = this.intentTypeByEventId.get(causedByEventId);
      if (
        causeIntentType &&
        !agentSessionReplayIntentAllowsEffect(causeIntentType, command.type)
      ) {
        this.registerDefect(command, commandId, "disallowed-effect");
      }
    }
    const hasRecordableCause = Boolean(
      causedByEventId && !this.defectsByCommandId.has(commandId)
    );
    this.observedCommands.set(commandId, {
      agentSessionId: commandAgentSessionId(command),
      ...(hasRecordableCause ? { causedByEventId } : {}),
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
    if (!isReplayableAgentSessionActivityIntentType(intent.type)) return;
    const correlationId = agentSessionReplayIntentCorrelationId(intent);
    const event = this.appendEvent({
      agentSessionId: intentAgentSessionId(intent),
      ...(correlationId ? { correlationId } : {}),
      kind: "intent",
      payload: payloadWithoutCommonFields(intent),
      type: intent.type
    });
    for (const candidate of agentSessionReplayIntentCorrelationCandidates(
      intent
    )) {
      this.eventIdByCorrelationId.set(candidate, event.eventId);
    }
    if (event.correlationId) {
      this.correlationIdByEventId.set(event.eventId, event.correlationId);
    }
    this.intentTypeByEventId.set(event.eventId, event.type);
    this.scheduleFlush();
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
    const drain = this.flushPendingBatches();
    this.flushInFlight = drain;
    try {
      await drain;
    } finally {
      if (this.flushInFlight === drain) {
        this.flushInFlight = null;
      }
    }
  }

  private async flushPendingBatches(): Promise<void> {
    while (this.active && this.pending.length > 0) {
      const active = this.active;
      const batchSize = Math.min(this.pending.length, this.maxBatchSize);
      const events = this.pending.slice(0, batchSize);
      await this.appender.append({
        events,
        recordingId: active.recordingId
      });
      this.pending.splice(0, batchSize);
    }
  }

  /** Accumulated fail-closed defects, inspectable before seal(). */
  getRecordingDefects(): readonly AgentSessionActivityRecordingDefect[] {
    return [...this.defectsByCommandId.values()];
  }

  async seal(recordingId?: string): Promise<void> {
    if (!this.active) return;
    this.assertActiveRecording(recordingId);
    this.sealed = true;
    const failures = this.sealFailures();
    if (failures.length > 0) {
      throw new Error(
        `activity event recording ${this.active.recordingId} is not ` +
          `replayable: ${failures.map(describeDefect).join("; ")}`
      );
    }
    await this.flush();
    this.active = null;
    this.clearCorrelationState();
  }

  discard(recordingId?: string): void {
    if (this.active) this.assertActiveRecording(recordingId);
    this.active = null;
    this.sealed = false;
    this.pending = [];
    this.clearCorrelationState();
  }

  private sealFailures(): AgentSessionActivityRecordingDefect[] {
    return [
      ...this.defectsByCommandId.values(),
      ...[...this.observedCommands.entries()]
        .filter(([commandId]) => !this.defectsByCommandId.has(commandId))
        .map(
          ([commandId, observed]): AgentSessionActivityRecordingDefect => ({
            commandId,
            commandType: observed.command.type,
            correlationId: observed.correlationId ?? null,
            reason: "unsettled-command"
          })
        )
    ];
  }

  private registerDefect(
    command: EngineExternalCommand,
    commandId: string,
    reason: AgentSessionActivityRecordingDefect["reason"]
  ): void {
    if (this.defectsByCommandId.has(commandId)) return;
    this.defectsByCommandId.set(commandId, {
      commandId,
      commandType: command.type,
      correlationId: commandCorrelationId(command) ?? null,
      reason
    });
  }

  private clearCorrelationState(): void {
    this.eventIdByCorrelationId.clear();
    this.correlationIdByEventId.clear();
    this.intentTypeByEventId.clear();
    this.observedCommands.clear();
    this.defectsByCommandId.clear();
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
    if (!command.causedByEventId) {
      // Defect was registered when the command was observed; the settled
      // result keeps it a defect instead of silently dropping the effect.
      this.registerDefect(
        command.command,
        intent.commandId,
        "uncorrelated-command"
      );
      return;
    }
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
    // Workflow rejects effects whose correlation disagrees with the causing
    // intent. Prefer the intent's recorded correlation over the command's.
    const correlationId =
      this.correlationIdByEventId.get(command.causedByEventId) ??
      intent.correlationId ??
      command.correlationId;
    this.appendEvent({
      agentSessionId: command.agentSessionId,
      causedByEventId: command.causedByEventId,
      ...(correlationId ? { correlationId } : {}),
      kind: "effect",
      payload,
      type: intent.commandType
    });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    void this.flush().catch(() => {
      // Keep the pending batch for seal() to retry and report.
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

function describeDefect(defect: AgentSessionActivityRecordingDefect): string {
  return (
    `${defect.reason} commandType=${defect.commandType} ` +
    `commandId=${defect.commandId} ` +
    `correlationId=${defect.correlationId ?? "<none>"}`
  );
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

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
