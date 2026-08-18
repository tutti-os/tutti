import type {
  PermissionMode,
  SDKMessage
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncPromptQueue } from "./promptQueue.ts";
import { readSDKMessageUuid } from "./sdkMessages.ts";
import type { PendingFlagSettings } from "./sessionSettings.ts";
import {
  readQueuedTaskNotificationPrompt,
  readUserMessageNotificationText
} from "./taskNotification.ts";
import { stringValue } from "./runtimeValues.ts";

export type ClaudeQueryRuntime = AsyncIterable<SDKMessage> & {
  initializationResult?: () => Promise<unknown>;
  interrupt?: () => Promise<void>;
  stopTask?: (taskId: string) => Promise<void>;
  setPermissionMode?: (mode: PermissionMode) => Promise<void>;
  setModel?: (model?: string) => Promise<void>;
  applyFlagSettings?: (settings: PendingFlagSettings) => Promise<void>;
  getContextUsage?: () => Promise<unknown>;
  close?: () => void;
};

export const DEFAULT_QUERY_INTERRUPT_TIMEOUT_MS = 10_000;
export const DEFAULT_QUERY_DRAIN_TIMEOUT_MS = 8_000;

export type QueryShutdownStage =
  | "shutdown_started"
  | "interrupt_started"
  | "interrupt_succeeded"
  | "interrupt_failed"
  | "interrupt_timed_out"
  | "query_close_started"
  | "query_close_succeeded"
  | "query_close_failed"
  | "consumption_wait_started"
  | "consumption_settled"
  | "consumption_timed_out"
  | "shutdown_succeeded";

export type QueryShutdownOptions = {
  interruptTimeoutMs?: number;
  drainTimeoutMs?: number;
  observe?: (
    stage: QueryShutdownStage,
    payload: Record<string, unknown>
  ) => void;
};

export type QueryShutdownResult = {
  terminationMode: "interrupt_acknowledged" | "transport_closed";
};

export class QueryShutdownTimeoutError extends Error {
  readonly stage = "consumption" as const;

  constructor(timeoutMs: number) {
    super(`Claude SDK Query consumption timed out after ${timeoutMs}ms`);
    this.name = "QueryShutdownTimeoutError";
  }
}

export class QueryGeneration {
  readonly promptQueue = new AsyncPromptQueue();
  readonly cancelController = new AbortController();
  readonly id: number;
  query: ClaudeQueryRuntime | undefined;
  consumption: Promise<void> | undefined;
  revoked = false;
  private readonly ownedTurnIds = new Set<string>();
  private quarantineCanceledTail: boolean;
  private expectedPromptUuid = "";
  private currentPromptObserved = false;
  private canceledTaskTailObserved = false;

  constructor(id: number, quarantineCanceledTail = false) {
    this.id = id;
    this.quarantineCanceledTail = quarantineCanceledTail;
  }

  /**
   * A Query generation owns the canonical Turns it has accepted, including
   * provider-native continuation Turns that are created after the original
   * root Turn stops being the in-memory active Turn. Keep this association on
   * the generation so an exact root cancel cannot be confused with a stale
   * request merely because a synthetic continuation is currently active.
   */
  registerTurn(turnId: string): void {
    turnId = turnId.trim();
    if (turnId) {
      this.ownedTurnIds.add(turnId);
    }
  }

  ownsTurn(turnId: string): boolean {
    return this.ownedTurnIds.has(turnId.trim());
  }

  static retire(
    generation: QueryGeneration | undefined,
    detachOwner: () => void
  ): void {
    // Detach first so the consumer's finally block cannot close the live
    // Session while this obsolete generation unwinds.
    detachOwner();
    generation?.revoke();
    generation?.closeQuery();
  }

  expectPromptEcho(promptUuid: string): void {
    if (this.quarantineCanceledTail) {
      this.expectedPromptUuid = promptUuid.trim();
    }
  }

  shouldRouteMessage(message: SDKMessage): boolean {
    if (!this.quarantineCanceledTail) {
      return true;
    }
    const raw = message as unknown as Record<string, unknown>;
    const messageType = stringValue(raw.type);
    const parentToolUseId = stringValue(raw.parent_tool_use_id);
    if (this.isCurrentPromptEcho(message, messageType, parentToolUseId)) {
      this.currentPromptObserved = true;
      return true;
    }
    if (isTaskLifecycleTail(message, messageType)) {
      this.canceledTaskTailObserved = true;
      return false;
    }
    if (messageType === "result" && !parentToolUseId) {
      if (this.canceledTaskTailObserved || !this.currentPromptObserved) {
        this.canceledTaskTailObserved = false;
        return false;
      }
      this.clearCanceledTailQuarantine();
      return true;
    }
    if (messageType === "assistant" && !parentToolUseId) {
      this.clearCanceledTailQuarantine();
    }
    return true;
  }

  revoke(): void {
    if (this.revoked) {
      return;
    }
    this.revoked = true;
    this.promptQueue.close();
    this.cancelController.abort();
  }

  closeQuery(): void {
    this.query?.close?.();
  }

  async shutdown(
    interrupt: boolean,
    options: QueryShutdownOptions = {}
  ): Promise<QueryShutdownResult> {
    const interruptTimeoutMs = positiveTimeout(
      options.interruptTimeoutMs,
      DEFAULT_QUERY_INTERRUPT_TIMEOUT_MS
    );
    const drainTimeoutMs = positiveTimeout(
      options.drainTimeoutMs,
      DEFAULT_QUERY_DRAIN_TIMEOUT_MS
    );
    const report = (
      stage: QueryShutdownStage,
      payload: Record<string, unknown>
    ): void => {
      try {
        options.observe?.(stage, payload);
      } catch {
        // Diagnostics must not change cancellation semantics.
      }
    };
    const shutdownStartedAt = Date.now();
    let terminationMode: QueryShutdownResult["terminationMode"] =
      interrupt && this.query?.interrupt
        ? "interrupt_acknowledged"
        : "transport_closed";
    this.revoke();
    report("shutdown_started", {
      generationId: this.id,
      interrupt,
      interruptTimeoutMs,
      drainTimeoutMs,
      hasQuery: Boolean(this.query),
      hasConsumption: Boolean(this.consumption)
    });

    if (interrupt && this.query?.interrupt) {
      const interruptStartedAt = Date.now();
      report("interrupt_started", { generationId: this.id });
      const interruptResult = await settleWithin(
        Promise.resolve().then(() => this.query?.interrupt?.()),
        interruptTimeoutMs
      );
      if (interruptResult.kind === "resolved") {
        report("interrupt_succeeded", {
          generationId: this.id,
          durationMs: Date.now() - interruptStartedAt
        });
      } else {
        terminationMode = "transport_closed";
        report(
          interruptResult.kind === "timeout"
            ? "interrupt_timed_out"
            : "interrupt_failed",
          {
            generationId: this.id,
            durationMs: Date.now() - interruptStartedAt,
            ...(interruptResult.kind === "rejected"
              ? { error: diagnosticError(interruptResult.error) }
              : { timeoutMs: interruptTimeoutMs })
          }
        );
      }
    }

    report("query_close_started", { generationId: this.id });
    try {
      this.closeQuery();
      report("query_close_succeeded", { generationId: this.id });
    } catch (error) {
      report("query_close_failed", {
        generationId: this.id,
        error: diagnosticError(error)
      });
      throw error;
    }

    const consumptionStartedAt = Date.now();
    report("consumption_wait_started", { generationId: this.id });
    const consumptionResult = await settleWithin(
      this.consumption ?? Promise.resolve(),
      drainTimeoutMs
    );
    if (consumptionResult.kind === "timeout") {
      report("consumption_timed_out", {
        generationId: this.id,
        durationMs: Date.now() - consumptionStartedAt,
        timeoutMs: drainTimeoutMs
      });
      throw new QueryShutdownTimeoutError(drainTimeoutMs);
    }
    if (consumptionResult.kind === "rejected") {
      throw consumptionResult.error;
    }
    report("consumption_settled", {
      generationId: this.id,
      durationMs: Date.now() - consumptionStartedAt
    });
    report("shutdown_succeeded", {
      generationId: this.id,
      durationMs: Date.now() - shutdownStartedAt,
      terminationMode
    });
    return { terminationMode };
  }

  private isCurrentPromptEcho(
    message: SDKMessage,
    messageType: string,
    parentToolUseId: string
  ): boolean {
    if (messageType !== "user" || parentToolUseId) {
      return false;
    }
    const notificationText = readUserMessageNotificationText(
      message as { message?: { content?: unknown } }
    );
    if (notificationText.includes("<task-notification>")) {
      return false;
    }
    return (
      readSDKMessageUuid(message) === this.expectedPromptUuid ||
      notificationText !== ""
    );
  }

  private clearCanceledTailQuarantine(): void {
    this.quarantineCanceledTail = false;
    this.expectedPromptUuid = "";
    this.currentPromptObserved = false;
    this.canceledTaskTailObserved = false;
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

type TimedSettlement<T> =
  | { kind: "resolved"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "timeout" };

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<TimedSettlement<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value): TimedSettlement<T> => ({ kind: "resolved", value }),
        (error: unknown): TimedSettlement<T> => ({ kind: "rejected", error })
      ),
      new Promise<TimedSettlement<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function diagnosticError(error: unknown): { name: string; message: string } {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error)
  };
}

function isTaskLifecycleTail(
  message: SDKMessage,
  messageType: string
): boolean {
  const raw = message as unknown as Record<string, unknown>;
  if (messageType === "system") {
    return [
      "task_started",
      "task_progress",
      "task_notification",
      "task_updated",
      "background_tasks_changed"
    ].includes(stringValue(raw.subtype));
  }
  if (messageType === "attachment") {
    return readQueuedTaskNotificationPrompt(raw).includes(
      "<task-notification>"
    );
  }
  if (messageType !== "user") {
    return false;
  }
  return readUserMessageNotificationText(
    message as { message?: { content?: unknown } }
  ).includes("<task-notification>");
}
