import type {
  AgentSessionEngine,
  EngineIntent
} from "@tutti-os/agent-activity-core";
import type { AgentSessionActivityEvent } from "./agentSessionActivityEventRecorder.ts";

export interface AgentSessionActivityReplayDriver {
  dispatchIntent(event: AgentSessionActivityEvent): void;
  dispose(): void;
  observeIntent(intent: EngineIntent): void;
  verifyEffect(event: AgentSessionActivityEvent): Promise<void>;
}

interface PendingEffectVerification {
  event: AgentSessionActivityEvent;
  reject(error: Error): void;
  resolve(): void;
  timer: ReturnType<typeof setTimeout>;
}

type CommandResultIntent = Extract<
  EngineIntent,
  { type: "engine/commandResult" }
>;

interface AgentSessionActivityReplayGlobal {
  __tuttiAgentSessionReplayDriver?: AgentSessionActivityReplayDriver;
}

const DEFAULT_EFFECT_TIMEOUT_MS = 30_000;

export function installAgentSessionActivityReplayDriver(input: {
  effectTimeoutMs?: number;
  engine: Pick<AgentSessionEngine, "dispatch" | "identity">;
}): AgentSessionActivityReplayDriver {
  const scopeId = input.engine.identity.workspaceId.trim();
  if (!scopeId) throw new Error("engine workspaceId is required");
  const effectTimeoutMs = input.effectTimeoutMs ?? DEFAULT_EFFECT_TIMEOUT_MS;
  if (!Number.isFinite(effectTimeoutMs) || effectTimeoutMs <= 0) {
    throw new Error("effectTimeoutMs must be greater than zero");
  }

  let disposed = false;
  const observedResults: CommandResultIntent[] = [];
  const pendingVerifications: PendingEffectVerification[] = [];

  const driver: AgentSessionActivityReplayDriver = {
    dispatchIntent(event) {
      assertActive();
      assertActivityEvent(event, "intent", scopeId);
      assertPayloadDoesNotOverrideScope(event.payload);
      input.engine.dispatch({
        type: event.type,
        workspaceId: event.scopeId,
        ...(event.agentSessionId
          ? { agentSessionId: event.agentSessionId }
          : {}),
        ...event.payload
      } as EngineIntent);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      observedResults.length = 0;
      for (const pending of pendingVerifications.splice(0)) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error("renderer activity replay driver was disposed")
        );
      }
      const replayGlobal = globalThis as typeof globalThis &
        AgentSessionActivityReplayGlobal;
      if (replayGlobal.__tuttiAgentSessionReplayDriver === driver) {
        delete replayGlobal.__tuttiAgentSessionReplayDriver;
      }
    },

    observeIntent(intent) {
      if (disposed || intent.type !== "engine/commandResult") return;
      const pendingIndex = pendingVerifications.findIndex((pending) =>
        isSameEffect(pending.event, intent)
      );
      if (pendingIndex < 0) {
        observedResults.push(structuredClone(intent));
        return;
      }
      const [pending] = pendingVerifications.splice(pendingIndex, 1);
      if (!pending) return;
      clearTimeout(pending.timer);
      settleEffectVerification(pending, intent);
    },

    verifyEffect(event) {
      assertActive();
      assertActivityEvent(event, "effect", scopeId);
      assertEffectPayload(event);
      const observedIndex = observedResults.findIndex((result) =>
        isSameEffect(event, result)
      );
      if (observedIndex >= 0) {
        const [result] = observedResults.splice(observedIndex, 1);
        if (!result) {
          return Promise.reject(
            new Error("observed command result disappeared")
          );
        }
        const mismatch = effectMismatch(event, result);
        return mismatch ? Promise.reject(mismatch) : Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const pending: PendingEffectVerification = {
          event: structuredClone(event),
          reject,
          resolve,
          timer: setTimeout(() => {
            const index = pendingVerifications.indexOf(pending);
            if (index >= 0) pendingVerifications.splice(index, 1);
            reject(
              new Error(
                `timed out waiting for renderer effect ${effectDescription(event)}`
              )
            );
          }, effectTimeoutMs)
        };
        pendingVerifications.push(pending);
      });
    }
  };

  function assertActive(): void {
    if (disposed) {
      throw new Error("renderer activity replay driver was disposed");
    }
  }

  (
    globalThis as typeof globalThis & AgentSessionActivityReplayGlobal
  ).__tuttiAgentSessionReplayDriver = driver;
  return driver;
}

function assertActivityEvent(
  event: AgentSessionActivityEvent,
  expectedKind: AgentSessionActivityEvent["kind"],
  expectedScopeId: string
): void {
  if (!event || typeof event !== "object") {
    throw new Error("activity event must be an object");
  }
  if (event.kind !== expectedKind) {
    throw new Error(
      `activity event kind mismatch: expected ${expectedKind}, got ${String(event.kind)}`
    );
  }
  if (event.scopeId !== expectedScopeId) {
    throw new Error(
      `activity event scope mismatch: expected ${expectedScopeId}, got ${String(event.scopeId)}`
    );
  }
  if (typeof event.type !== "string" || !event.type.trim()) {
    throw new Error("activity event type is required");
  }
  if (
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  ) {
    throw new Error("activity event payload must be an object");
  }
  if (
    event.agentSessionId !== undefined &&
    (typeof event.agentSessionId !== "string" || !event.agentSessionId.trim())
  ) {
    throw new Error("activity event agentSessionId must be non-empty");
  }
  if (
    event.correlationId !== undefined &&
    (typeof event.correlationId !== "string" || !event.correlationId.trim())
  ) {
    throw new Error("activity event correlationId must be non-empty");
  }
}

function assertPayloadDoesNotOverrideScope(
  payload: Readonly<Record<string, unknown>>
): void {
  for (const field of ["agentSessionId", "type", "workspaceId"]) {
    if (Object.hasOwn(payload, field)) {
      throw new Error(`activity event payload must not contain ${field}`);
    }
  }
}

function assertEffectPayload(event: AgentSessionActivityEvent): void {
  const outcome = event.payload.outcome;
  if (
    outcome !== "failed" &&
    outcome !== "succeeded" &&
    outcome !== "timedOut"
  ) {
    throw new Error(
      `renderer effect ${effectDescription(event)} has invalid outcome ${String(outcome)}`
    );
  }
  for (const field of ["errorCode", "errorReason"]) {
    const value = event.payload[field];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(
        `renderer effect ${effectDescription(event)} has invalid ${field}`
      );
    }
  }
}

function isSameEffect(
  event: AgentSessionActivityEvent,
  result: CommandResultIntent
): boolean {
  return (
    event.type === result.commandType &&
    normalizedCorrelationId(event.correlationId) ===
      normalizedCorrelationId(result.correlationId)
  );
}

function settleEffectVerification(
  pending: PendingEffectVerification,
  result: CommandResultIntent
): void {
  const mismatch = effectMismatch(pending.event, result);
  if (mismatch) {
    pending.reject(mismatch);
    return;
  }
  pending.resolve();
}

function effectMismatch(
  event: AgentSessionActivityEvent,
  result: CommandResultIntent
): Error | null {
  const expectedOutcome = event.payload
    .outcome as CommandResultIntent["outcome"];
  const differences: string[] = [];
  compareField(differences, "outcome", expectedOutcome, result.outcome);
  compareField(
    differences,
    "errorCode",
    optionalString(event.payload.errorCode),
    result.errorCode
  );
  compareField(
    differences,
    "errorReason",
    optionalString(event.payload.errorReason),
    result.errorReason
  );
  return differences.length === 0
    ? null
    : new Error(
        `renderer effect mismatch for ${effectDescription(event)}: ${differences.join(", ")}`
      );
}

function compareField(
  differences: string[],
  field: string,
  expected: string | undefined,
  actual: string | undefined
): void {
  if (expected === actual) return;
  differences.push(
    `${field} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizedCorrelationId(value: string | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function effectDescription(event: AgentSessionActivityEvent): string {
  const correlationId = normalizedCorrelationId(event.correlationId);
  return correlationId ? `${event.type} (${correlationId})` : event.type;
}
