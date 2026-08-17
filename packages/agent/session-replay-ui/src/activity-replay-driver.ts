import type {
  AgentSessionEngine,
  EngineExternalCommand,
  EngineIntent
} from "@tutti-os/agent-activity-core";
import {
  selectEngineInteraction,
  selectEngineInteractionsForSession,
  selectEngineSession,
  selectEngineTurn,
  selectEngineTurnsForSession
} from "@tutti-os/agent-activity-core";
import type { AgentSessionActivityEvent } from "./activity-event.ts";
import {
  agentSessionReplayEffectCommandIdBinding,
  agentSessionReplayIntentRequiresCommandId,
  alternateAgentSessionReplayEffectCorrelationField,
  isAgentSessionReplayIntentReady,
  isReplayableAgentSessionActivityEffectCommand,
  rebaseAgentSessionReplayIntentPayload,
  stableAgentSessionReplayEffectFields
} from "./interaction-contract.ts";

export interface AgentSessionActivityReplayCassetteRegistration {
  agentSessionIds: readonly string[];
  cassetteId: string;
}

export interface AgentSessionActivityReplayCassetteController {
  dispatchIntent(event: AgentSessionActivityEvent): void;
  dispose(): void;
  verifyEffect(event: AgentSessionActivityEvent): Promise<void>;
  waitUntilIntentReady?(event: AgentSessionActivityEvent): Promise<void>;
}

export interface AgentSessionActivityReplayDriver {
  dispose(): void;
  dispatchCassetteIntent(
    cassetteId: string,
    event: AgentSessionActivityEvent
  ): void;
  hasRegisteredCassettes(): boolean;
  observeCommand(command: EngineExternalCommand): void;
  observeIntent(intent: EngineIntent): void;
  registerCassette(
    registration: AgentSessionActivityReplayCassetteRegistration
  ): AgentSessionActivityReplayCassetteController;
  removeCassette(cassetteId: string): void;
  waitUntilCassetteIntentReady?(
    cassetteId: string,
    event: AgentSessionActivityEvent
  ): Promise<void>;
  verifyCassetteEffect(
    cassetteId: string,
    event: AgentSessionActivityEvent
  ): Promise<void>;
}

interface ObservedCommand {
  agentSessionId: string | null;
  commandId: string;
  correlationId: string | null;
  payload: Readonly<Record<string, unknown>>;
  type: string;
}

interface PendingEffectVerification {
  commandId: string | null;
  event: AgentSessionActivityEvent;
  reject(error: Error): void;
  resolve(): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReplayCassetteState {
  agentSessionIds: Set<string>;
  commandIdByCorrelationId: Map<string, string>;
  controller: AgentSessionActivityReplayCassetteController;
  observedCommands: ObservedCommand[];
  observedResultsByCommandId: Map<string, CommandResultIntent>;
  pendingVerifications: PendingEffectVerification[];
  cassetteId: string;
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
  engine: Pick<AgentSessionEngine, "dispatch" | "identity"> &
    Partial<Pick<AgentSessionEngine, "getSnapshot" | "subscribe">>;
  nowUnixMs?: () => number;
}): AgentSessionActivityReplayDriver {
  const scopeId = input.engine.identity.workspaceId.trim();
  if (!scopeId) throw new Error("engine workspaceId is required");
  const effectTimeoutMs = input.effectTimeoutMs ?? DEFAULT_EFFECT_TIMEOUT_MS;
  if (!Number.isFinite(effectTimeoutMs) || effectTimeoutMs <= 0) {
    throw new Error("effectTimeoutMs must be greater than zero");
  }

  let disposed = false;
  let fatalError: Error | null = null;
  const cassettesById = new Map<string, ReplayCassetteState>();
  const cassetteIdByAgentSessionId = new Map<string, string>();
  const cassetteIdByCommandId = new Map<string, string>();
  const completedCommandIds = new Set<string>();

  const driver: AgentSessionActivityReplayDriver = {
    dispatchCassetteIntent(cassetteId, event) {
      registeredCassette(cassetteId).controller.dispatchIntent(event);
    },

    hasRegisteredCassettes() {
      return cassettesById.size > 0;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cassetteId of [...cassettesById.keys()]) {
        removeCassette(
          cassetteId,
          new Error("renderer activity replay driver was disposed")
        );
      }
      cassetteIdByCommandId.clear();
      completedCommandIds.clear();
      const replayGlobal = globalThis as typeof globalThis &
        AgentSessionActivityReplayGlobal;
      if (replayGlobal.__tuttiAgentSessionReplayDriver === driver) {
        delete replayGlobal.__tuttiAgentSessionReplayDriver;
      }
    },

    observeCommand(command) {
      assertActive();
      if (!isReplayableAgentSessionActivityEffectCommand(command.type)) return;
      const commandId = command.commandId.trim();
      if (!commandId) {
        failClosed(new Error("renderer activity replay commandId is required"));
      }
      if (
        cassetteIdByCommandId.has(commandId) ||
        completedCommandIds.has(commandId)
      ) {
        failClosed(
          new Error(`duplicate renderer activity replay commandId ${commandId}`)
        );
      }
      const cassette = resolveCommandCassette(command);
      cassetteIdByCommandId.set(commandId, cassette.cassetteId);
      const observedCommand: ObservedCommand = {
        agentSessionId: commandAgentSessionId(command),
        commandId,
        correlationId: commandCorrelationId(command),
        payload: stableEffectCommandPayload(command),
        type: command.type
      };
      const pending = cassette.pendingVerifications.find(
        (candidate) =>
          candidate.commandId === null &&
          isSameEffectCommand(cassette, candidate.event, observedCommand)
      );
      if (!pending) {
        cassette.observedCommands.push(observedCommand);
        return;
      }
      pending.commandId = commandId;
      settlePendingIfResultObserved(cassette, pending);
    },

    observeIntent(intent) {
      if (disposed || intent.type !== "engine/commandResult") return;
      assertHealthy();
      if (!isReplayableAgentSessionActivityEffectCommand(intent.commandType))
        return;
      const commandId = intent.commandId.trim();
      const cassetteId = cassetteIdByCommandId.get(commandId);
      if (!commandId || !cassetteId || completedCommandIds.has(commandId)) {
        failClosed(
          new Error(
            `unknown renderer activity replay command result ${commandId || "<empty>"}`
          )
        );
      }
      const cassette = cassettesById.get(cassetteId);
      if (!cassette) {
        failClosed(
          new Error(
            `renderer activity replay command ${commandId} references missing cassette ${cassetteId}`
          )
        );
      }
      cassetteIdByCommandId.delete(commandId);
      completedCommandIds.add(commandId);
      const pending = cassette.pendingVerifications.find(
        (candidate) => candidate.commandId === commandId
      );
      if (!pending) {
        cassette.observedResultsByCommandId.set(
          commandId,
          structuredClone(intent)
        );
        return;
      }
      settleEffectVerification(cassette, pending, intent);
    },

    registerCassette(registration) {
      assertActive();
      const cassetteId = registration.cassetteId.trim();
      if (!cassetteId) throw new Error("replay cassetteId is required");
      if (cassettesById.has(cassetteId)) {
        throw new Error(`replay cassette ${cassetteId} is already registered`);
      }
      const agentSessionIds = normalizeAgentSessionIds(
        registration.agentSessionIds
      );
      for (const agentSessionId of agentSessionIds) {
        const owner = cassetteIdByAgentSessionId.get(agentSessionId);
        if (owner) {
          throw new Error(
            `Agent Session ${agentSessionId} is already registered to replay cassette ${owner}`
          );
        }
      }
      const cassette = createCassette(cassetteId, agentSessionIds);
      cassettesById.set(cassetteId, cassette);
      for (const agentSessionId of agentSessionIds) {
        cassetteIdByAgentSessionId.set(agentSessionId, cassetteId);
      }
      return cassette.controller;
    },

    removeCassette(cassetteId) {
      assertActive();
      removeCassette(
        normalizeCassetteId(cassetteId),
        new Error("renderer activity replay cassette was disposed")
      );
    },

    verifyCassetteEffect(cassetteId, event) {
      return registeredCassette(cassetteId).controller.verifyEffect(event);
    },

    waitUntilCassetteIntentReady(cassetteId, event) {
      return (
        registeredCassette(cassetteId).controller.waitUntilIntentReady?.(
          event
        ) ?? Promise.resolve()
      );
    }
  };

  function createCassette(
    cassetteId: string,
    agentSessionIds: readonly string[]
  ): ReplayCassetteState {
    let cassette: ReplayCassetteState;
    const controller: AgentSessionActivityReplayCassetteController = {
      dispatchIntent(event) {
        assertActive();
        assertActivityEvent(event, "intent", scopeId);
        assertPayloadDoesNotOverrideScope(event.payload);
        assertCassetteOwnsEvent(cassette, event);
        input.engine.dispatch({
          type: event.type,
          workspaceId: event.scopeId,
          ...(event.agentSessionId
            ? { agentSessionId: event.agentSessionId }
            : {}),
          ...materializeReplayIntentPayload(
            cassette,
            event,
            input.nowUnixMs?.() ?? Date.now()
          )
        } as EngineIntent);
        assertHealthy();
      },
      dispose() {
        if (!cassettesById.has(cassetteId)) return;
        removeCassette(
          cassetteId,
          new Error("renderer activity replay cassette was disposed")
        );
      },
      verifyEffect(event) {
        assertActive();
        assertActivityEvent(event, "effect", scopeId);
        assertEffectPayload(event);
        assertCassetteOwnsEvent(cassette, event);
        const commandIndex = cassette.observedCommands.findIndex((command) =>
          isSameEffectCommand(cassette, event, command)
        );
        const command =
          commandIndex < 0
            ? null
            : (cassette.observedCommands.splice(commandIndex, 1)[0] ?? null);
        return new Promise<void>((resolve, reject) => {
          const pending: PendingEffectVerification = {
            commandId: command?.commandId ?? null,
            event: structuredClone(event),
            reject,
            resolve,
            timer: setTimeout(() => {
              const index = cassette.pendingVerifications.indexOf(pending);
              if (index >= 0) cassette.pendingVerifications.splice(index, 1);
              reject(
                new Error(
                  `timed out waiting for renderer effect ${effectDescription(event)}; ` +
                    `commandId=${pending.commandId ?? "<unmatched>"}; ` +
                    `observedCommands=${JSON.stringify(cassette.observedCommands)}; ` +
                    `observedResultCommandIds=${JSON.stringify([
                      ...cassette.observedResultsByCommandId.keys()
                    ])}`
                )
              );
            }, effectTimeoutMs)
          };
          cassette.pendingVerifications.push(pending);
          settlePendingIfResultObserved(cassette, pending);
        });
      },
      waitUntilIntentReady(event) {
        assertActive();
        assertActivityEvent(event, "intent", scopeId);
        return waitForCassetteIntentReadiness(cassette, event);
      }
    };
    cassette = {
      agentSessionIds: new Set(agentSessionIds),
      commandIdByCorrelationId: new Map(),
      controller,
      observedCommands: [],
      observedResultsByCommandId: new Map(),
      pendingVerifications: [],
      cassetteId
    };
    return cassette;
  }

  function registeredCassette(cassetteId: string): ReplayCassetteState {
    assertActive();
    const normalized = normalizeCassetteId(cassetteId);
    const cassette = cassettesById.get(normalized);
    if (!cassette) {
      throw new Error(`replay cassette ${normalized} is not registered`);
    }
    return cassette;
  }

  function assertCassetteOwnsEvent(
    cassette: ReplayCassetteState,
    event: AgentSessionActivityEvent
  ): void {
    if (
      !claimCassetteEventSession(cassette, event, input.engine.getSnapshot?.())
    ) {
      throw new Error(
        `replay cassette ${cassette.cassetteId} does not own Agent Session ${event.agentSessionId}`
      );
    }
  }

  function claimCassetteEventSession(
    cassette: ReplayCassetteState,
    event: AgentSessionActivityEvent,
    snapshot: ReturnType<AgentSessionEngine["getSnapshot"]> | undefined
  ): boolean {
    const agentSessionId = normalizedAgentSessionId(event.agentSessionId);
    if (
      cassette.agentSessionIds.size === 0 ||
      !agentSessionId ||
      cassette.agentSessionIds.has(agentSessionId)
    ) {
      return true;
    }
    const session = snapshot
      ? selectEngineSession(snapshot, agentSessionId)
      : null;
    if (!session) return false;
    const rootAgentSessionId = session?.rootAgentSessionId?.trim() ?? "";
    if (
      session?.kind !== "child" ||
      session.workspaceId.trim() !== scopeId ||
      !rootAgentSessionId ||
      !cassette.agentSessionIds.has(rootAgentSessionId)
    ) {
      throw new Error(
        `replay cassette ${cassette.cassetteId} does not own Agent Session ${event.agentSessionId}`
      );
    }
    const owner = cassetteIdByAgentSessionId.get(agentSessionId);
    if (owner && owner !== cassette.cassetteId) {
      throw new Error(
        `Agent Session ${agentSessionId} is already registered to replay cassette ${owner}`
      );
    }
    cassette.agentSessionIds.add(agentSessionId);
    cassetteIdByAgentSessionId.set(agentSessionId, cassette.cassetteId);
    return true;
  }

  function waitForCassetteIntentReadiness(
    cassette: ReplayCassetteState,
    event: AgentSessionActivityEvent
  ): Promise<void> {
    if (!input.engine.getSnapshot || !input.engine.subscribe) {
      assertCassetteOwnsEvent(cassette, event);
      return Promise.resolve();
    }
    const isReady = (
      snapshot: ReturnType<AgentSessionEngine["getSnapshot"]>
    ): boolean =>
      claimCassetteEventSession(cassette, event, snapshot) &&
      isIntentReady(snapshot, event);
    if (isReady(input.engine.getSnapshot())) return Promise.resolve();
    const subscribe = input.engine.subscribe;
    return new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const timer = setTimeout(() => {
        unsubscribe();
        const snapshot = input.engine.getSnapshot!();
        reject(
          new Error(
            `timed out waiting for renderer intent readiness ${event.type} ` +
              `${event.agentSessionId ?? "<missing>"}; ` +
              intentReadinessDiagnostic(snapshot, event)
          )
        );
      }, effectTimeoutMs);
      const settleIfReady = (
        snapshot: ReturnType<AgentSessionEngine["getSnapshot"]>
      ): void => {
        try {
          if (!isReady(snapshot)) return;
          clearTimeout(timer);
          unsubscribe();
          resolve();
        } catch (error) {
          clearTimeout(timer);
          unsubscribe();
          reject(error);
        }
      };
      unsubscribe = subscribe(settleIfReady);
      settleIfReady(input.engine.getSnapshot!());
    });
  }

  function resolveCommandCassette(
    command: EngineExternalCommand
  ): ReplayCassetteState {
    const agentSessionId = commandAgentSessionId(command);
    const cassetteId = agentSessionId
      ? cassetteIdByAgentSessionId.get(agentSessionId)
      : undefined;
    const cassette = cassetteId ? cassettesById.get(cassetteId) : undefined;
    if (!cassette) {
      failClosed(
        new Error(
          `no replay cassette registered for command ${command.commandId} Agent Session ${agentSessionId ?? "<missing>"}`
        )
      );
    }
    return cassette;
  }

  function settlePendingIfResultObserved(
    cassette: ReplayCassetteState,
    pending: PendingEffectVerification
  ): void {
    if (!pending.commandId) return;
    const result = cassette.observedResultsByCommandId.get(pending.commandId);
    if (!result) return;
    cassette.observedResultsByCommandId.delete(pending.commandId);
    settleEffectVerification(cassette, pending, result);
  }

  function removeCassette(cassetteId: string, reason: Error): void {
    const cassette = cassettesById.get(cassetteId);
    if (!cassette) return;
    cassettesById.delete(cassetteId);
    for (const agentSessionId of cassette.agentSessionIds) {
      if (cassetteIdByAgentSessionId.get(agentSessionId) === cassetteId) {
        cassetteIdByAgentSessionId.delete(agentSessionId);
      }
    }
    for (const [commandId, ownerCassetteId] of cassetteIdByCommandId) {
      if (ownerCassetteId === cassetteId)
        cassetteIdByCommandId.delete(commandId);
    }
    rejectPendingVerifications(cassette, reason);
    cassette.observedCommands.length = 0;
    cassette.observedResultsByCommandId.clear();
    cassette.commandIdByCorrelationId.clear();
  }

  function failClosed(error: Error): never {
    if (!fatalError) {
      fatalError = error;
      for (const cassette of cassettesById.values()) {
        rejectPendingVerifications(cassette, error);
      }
    }
    throw fatalError;
  }

  function assertActive(): void {
    if (disposed) {
      throw new Error("renderer activity replay driver was disposed");
    }
    assertHealthy();
  }

  function assertHealthy(): void {
    if (fatalError) throw fatalError;
  }

  (
    globalThis as typeof globalThis & AgentSessionActivityReplayGlobal
  ).__tuttiAgentSessionReplayDriver = driver;
  return driver;
}

function intentReadinessDiagnostic(
  snapshot: ReturnType<AgentSessionEngine["getSnapshot"]>,
  event: AgentSessionActivityEvent
): string {
  const agentSessionId = normalizedAgentSessionId(event.agentSessionId);
  if (!agentSessionId) return "session=<missing>";
  const session = selectEngineSession(snapshot, agentSessionId);
  if (!session) return "session=absent";
  const turnId = optionalString(event.payload.turnId)?.trim() ?? "";
  const requestId = optionalString(event.payload.requestId)?.trim() ?? "";
  const turn = selectEngineTurn(snapshot, agentSessionId, turnId);
  const interaction = selectEngineInteraction(
    snapshot,
    agentSessionId,
    turnId,
    requestId
  );
  const turns = selectEngineTurnsForSession(snapshot, agentSessionId).map(
    (item) => `${item.turnId}:${item.phase}`
  );
  const interactions = selectEngineInteractionsForSession(
    snapshot,
    agentSessionId
  ).map((item) => `${item.turnId}/${item.requestId}:${item.status}`);
  return [
    `session=${session.kind}`,
    `activeTurn=${session.activeTurnId ?? "<none>"}`,
    `expectedTurn=${turnId || "<missing>"}:${turn?.phase ?? "absent"}`,
    `expectedInteraction=${requestId || "<missing>"}:${interaction?.status ?? "absent"}`,
    `turns=[${turns.join(",")}]`,
    `interactions=[${interactions.join(",")}]`
  ].join(" ");
}

export function rebaseReplayIntentPayload(
  event: AgentSessionActivityEvent,
  nowUnixMs: number
): Readonly<Record<string, unknown>> {
  return rebaseAgentSessionReplayIntentPayload(
    event.type,
    event.payload,
    event.occurredAtUnixMs,
    nowUnixMs
  );
}

function materializeReplayIntentPayload(
  cassette: ReplayCassetteState,
  event: AgentSessionActivityEvent,
  nowUnixMs: number
): Readonly<Record<string, unknown>> {
  const payload = rebaseReplayIntentPayload(event, nowUnixMs);
  const correlationId = normalizedCorrelationId(event.correlationId);
  const boundCommandId = agentSessionReplayEffectCommandIdBinding(
    event.type,
    payload
  );
  if (boundCommandId) {
    if (!correlationId) {
      throw new Error(
        `replay intent ${event.type} requires a stable correlationId to bind its engine commandId`
      );
    }
    bindReplayCommandId(cassette, correlationId, boundCommandId);
  }
  if (!agentSessionReplayIntentRequiresCommandId(event.type)) return payload;
  if (!correlationId) {
    throw new Error(
      `replay intent ${event.type} requires a stable correlationId to materialize commandId`
    );
  }
  const commandId = replayCommandId(cassette.cassetteId, event.eventId);
  bindReplayCommandId(cassette, correlationId, commandId);
  return { ...payload, commandId };
}

function bindReplayCommandId(
  cassette: ReplayCassetteState,
  correlationId: string,
  commandId: string
): void {
  const existingCommandId =
    cassette.commandIdByCorrelationId.get(correlationId);
  if (existingCommandId && existingCommandId !== commandId) {
    throw new Error(
      `replay cassette ${cassette.cassetteId} reuses correlationId ${correlationId}`
    );
  }
  cassette.commandIdByCorrelationId.set(correlationId, commandId);
}

function replayCommandId(cassetteId: string, eventId: string): string {
  return `replay:${cassetteId}:${eventId}`;
}

function rejectPendingVerifications(
  cassette: ReplayCassetteState,
  reason: Error
): void {
  for (const pending of cassette.pendingVerifications.splice(0)) {
    clearTimeout(pending.timer);
    pending.reject(reason);
  }
}

function settleEffectVerification(
  cassette: ReplayCassetteState,
  pending: PendingEffectVerification,
  result: CommandResultIntent
): void {
  const index = cassette.pendingVerifications.indexOf(pending);
  if (index >= 0) cassette.pendingVerifications.splice(index, 1);
  clearTimeout(pending.timer);
  const mismatch = effectMismatch(pending.event, result);
  if (mismatch) {
    pending.reject(mismatch);
    return;
  }
  pending.resolve();
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

function isSameEffectCommand(
  cassette: ReplayCassetteState,
  event: AgentSessionActivityEvent,
  command: ObservedCommand
): boolean {
  const stablePayloadMatches =
    stableValue(eventStableEffectCommandPayload(event)) ===
    stableValue(command.payload);
  const hasComparableStableField =
    stableAgentSessionReplayEffectFields(command.type)?.some(
      (field) =>
        Object.hasOwn(event.payload, field) &&
        Object.hasOwn(command.payload, field)
    ) ?? false;
  return (
    event.type === command.type &&
    normalizedAgentSessionId(event.agentSessionId) === command.agentSessionId &&
    (isSameEffectBoundCommandId(cassette, event, command) ||
      (isSameEffectCorrelation(event, command, hasComparableStableField) &&
        stablePayloadMatches))
  );
}

function isSameEffectBoundCommandId(
  cassette: ReplayCassetteState,
  event: AgentSessionActivityEvent,
  command: ObservedCommand
): boolean {
  const correlationId = normalizedCorrelationId(event.correlationId);
  const replayCommandId = correlationId
    ? cassette.commandIdByCorrelationId.get(correlationId)
    : undefined;
  return replayCommandId === command.commandId;
}

function isSameEffectCorrelation(
  event: AgentSessionActivityEvent,
  command: ObservedCommand,
  hasComparableStableField: boolean
): boolean {
  const correlationId = normalizedCorrelationId(event.correlationId);
  if (correlationId && correlationId === command.correlationId) return true;
  if (!correlationId && !command.correlationId) {
    return hasComparableStableField;
  }
  // Declared alternate correlation rule from the interaction contract. The
  // matched payload field also remains part of the stable-field comparison.
  const alternateField = alternateAgentSessionReplayEffectCorrelationField(
    event.type
  );
  if (!alternateField) return false;
  const eventValue = event.payload[alternateField];
  return (
    typeof eventValue === "string" &&
    eventValue.trim() !== "" &&
    eventValue === command.payload[alternateField]
  );
}

function stableEffectCommandPayload(
  command: EngineExternalCommand
): Readonly<Record<string, unknown>> {
  return pickStableEffectFields(
    command.type,
    command as unknown as Readonly<Record<string, unknown>>
  );
}

function eventStableEffectCommandPayload(
  event: AgentSessionActivityEvent
): Readonly<Record<string, unknown>> {
  return pickStableEffectFields(
    event.type as EngineExternalCommand["type"],
    event.payload
  );
}

function pickStableEffectFields(
  type: EngineExternalCommand["type"],
  value: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const fields = stableAgentSessionReplayEffectFields(type);
  if (!fields) return {};
  return Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(value, field))
      .map((field) => [field, structuredClone(value[field])])
  );
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableValue).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableValue(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function isIntentReady(
  snapshot: ReturnType<AgentSessionEngine["getSnapshot"]>,
  event: AgentSessionActivityEvent
): boolean {
  return isAgentSessionReplayIntentReady(snapshot, event);
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

function commandAgentSessionId(command: EngineExternalCommand): string | null {
  return "agentSessionId" in command &&
    typeof command.agentSessionId === "string" &&
    command.agentSessionId.trim()
    ? command.agentSessionId.trim()
    : null;
}

function commandCorrelationId(command: EngineExternalCommand): string | null {
  return "correlationId" in command && typeof command.correlationId === "string"
    ? normalizedCorrelationId(command.correlationId)
    : null;
}

function normalizeAgentSessionIds(values: readonly string[]): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()))];
  if (normalized.length === 0 || normalized.some((value) => !value)) {
    throw new Error("replay cassette requires non-empty Agent Session ids");
  }
  return normalized;
}

function normalizeCassetteId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("replay cassetteId is required");
  return normalized;
}

function normalizedCorrelationId(value: string | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedAgentSessionId(value: string | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function effectDescription(event: AgentSessionActivityEvent): string {
  const correlationId = normalizedCorrelationId(event.correlationId);
  return correlationId ? `${event.type} (${correlationId})` : event.type;
}
