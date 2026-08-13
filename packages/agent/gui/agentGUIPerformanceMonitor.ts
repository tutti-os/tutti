import {
  selectEngineSession,
  selectEngineTurn,
  selectPendingActivations,
  selectPendingSubmits,
  type AgentActivityComposerOptions,
  type AgentSessionEngine,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import type {
  AgentGUIComposerOptionsLoadSource,
  AgentGUIComposerOptionsPerformanceEvent,
  AgentGUIFirstTokenKind,
  AgentGUIPerformanceDurationBucket,
  AgentGUIPerformanceEvent
} from "./agentGUIPerformanceEvents.ts";

export type {
  AgentGUIComposerOptionsLoadSource,
  AgentGUIComposerOptionsPerformanceEvent,
  AgentGUIFirstTokenKind,
  AgentGUIPerformanceDurationBucket,
  AgentGUIPerformanceEvent
} from "./agentGUIPerformanceEvents.ts";

const MAX_RETAINED_PERFORMANCE_RECORDS = 512;

export interface AgentGUIComposerOptionsLoadInput {
  agentTargetId: string;
  cwd?: string | null;
  force?: boolean;
  load: () => Promise<AgentActivityComposerOptions>;
  provider?: string | null;
  source: AgentGUIComposerOptionsLoadSource;
}

export interface AgentGUIComposerOptionsPerformanceTrackerInput extends AgentGUIComposerOptionsLoadInput {
  createOperationId?: () => string;
  nowUnixMs?: () => number;
  onEvent: (event: AgentGUIComposerOptionsPerformanceEvent) => void;
  workspaceId: string;
}

export interface AgentGUIPerformanceMonitor {
  dispose(): void;
  trackComposerOptionsLoad(
    input: AgentGUIComposerOptionsLoadInput
  ): Promise<AgentActivityComposerOptions>;
}

interface PromptAttempt {
  agentSessionId: string;
  allowUnboundTurnMatch: boolean;
  operationId: string;
  queued: boolean;
  source: "activation" | "submit";
  startedAtUnixMs: number;
  turnId: string | null;
}

interface FirstTokenObservation {
  agentSessionId: string;
  firstTokenKind: AgentGUIFirstTokenKind;
  observedAtUnixMs: number;
  turnId: string;
}

interface TurnContext extends Omit<
  PromptAttempt,
  "allowUnboundTurnMatch" | "turnId"
> {
  turnId: string;
}

export function createAgentGUIPerformanceMonitor(input: {
  createOperationId?: () => string;
  engine: AgentSessionEngine;
  nowUnixMs?: () => number;
  onEvent: (event: AgentGUIPerformanceEvent) => void;
  subscribeSessionEvents: (listener: (event: unknown) => void) => () => void;
}): AgentGUIPerformanceMonitor {
  const workspaceId = input.engine.identity.workspaceId.trim();
  const nowUnixMs = input.nowUnixMs ?? Date.now;
  const attemptsByOperationId = new Map<string, PromptAttempt>();
  const attemptsByTurnKey = new Map<string, PromptAttempt>();
  const observationsByTurnKey = new Map<string, FirstTokenObservation>();
  const turnContexts = new Map<string, TurnContext>();
  const observedActivationRecords = new WeakSet<object>();
  const observedSubmitRecords = new WeakSet<object>();
  const seenPromptAttempts = new Set<string>();
  const reportedActivationSettlements = new Set<string>();
  const reportedPromptSettlements = new Set<string>();
  const reportedTurnSettlements = new Set<string>();
  let lastPendingActivations:
    | ReturnType<typeof selectPendingActivations>
    | undefined;
  let lastPendingSubmits: ReturnType<typeof selectPendingSubmits> | undefined;
  let disposed = false;

  const emit = (event: AgentGUIPerformanceEvent): void => {
    emitPerformanceEvent(input.onEvent, event);
  };

  const providerFor = (
    state: AgentSessionEngineState,
    agentSessionId: string
  ): string =>
    selectEngineSession(state, agentSessionId)?.provider?.trim() || "unknown";

  const clearOrphanedObservations = (agentSessionId: string): void => {
    const hasUnboundAttempt = [...attemptsByOperationId.values()].some(
      (attempt) =>
        attempt.agentSessionId === agentSessionId && attempt.turnId === null
    );
    if (hasUnboundAttempt) return;
    for (const [key, observation] of observationsByTurnKey) {
      if (observation.agentSessionId === agentSessionId) {
        observationsByTurnKey.delete(key);
      }
    }
  };

  const removeAttempt = (attempt: PromptAttempt): void => {
    attemptsByOperationId.delete(attempt.operationId);
    if (attempt.turnId) {
      attemptsByTurnKey.delete(
        performanceTurnKey(attempt.agentSessionId, attempt.turnId)
      );
    }
    clearOrphanedObservations(attempt.agentSessionId);
  };

  const reportFirstToken = (
    attempt: PromptAttempt,
    observation: FirstTokenObservation,
    state: AgentSessionEngineState
  ): void => {
    const key = performanceTurnKey(
      observation.agentSessionId,
      observation.turnId
    );
    turnContexts.set(key, turnContext(attempt, observation.turnId));
    trimMap(turnContexts);
    removeAttempt(attempt);
    observationsByTurnKey.delete(key);
    const duration = agentGUIPerformanceDuration(
      observation.observedAtUnixMs - attempt.startedAtUnixMs
    );
    emit({
      agentSessionId: attempt.agentSessionId,
      ...duration,
      firstTokenKind: observation.firstTokenKind,
      observedAtUnixMs: observation.observedAtUnixMs,
      operationId: attempt.operationId,
      provider: providerFor(state, attempt.agentSessionId),
      queued: attempt.queued,
      source: attempt.source,
      startedAtUnixMs: attempt.startedAtUnixMs,
      turnId: observation.turnId,
      type: "prompt_first_token_received",
      workspaceId
    });
  };

  const bindTurn = (
    attempt: PromptAttempt,
    turnId: string,
    state: AgentSessionEngineState
  ): void => {
    const normalizedTurnId = turnId.trim();
    if (!normalizedTurnId) return;
    attempt.turnId = normalizedTurnId;
    const key = performanceTurnKey(attempt.agentSessionId, normalizedTurnId);
    attemptsByTurnKey.set(key, attempt);
    turnContexts.set(key, turnContext(attempt, normalizedTurnId));
    trimMap(attemptsByTurnKey);
    trimMap(turnContexts);
    const observation = observationsByTurnKey.get(key);
    if (observation) {
      reportFirstToken(attempt, observation, state);
    } else {
      clearOrphanedObservations(attempt.agentSessionId);
    }
  };

  const trackPromptAttempt = (attempt: PromptAttempt): PromptAttempt | null => {
    if (seenPromptAttempts.has(attempt.operationId)) {
      return attemptsByOperationId.get(attempt.operationId) ?? null;
    }
    remember(seenPromptAttempts, attempt.operationId);
    attemptsByOperationId.set(attempt.operationId, attempt);
    trimMap(attemptsByOperationId);
    return attempt;
  };

  const reportState = (): void => {
    if (disposed) return;
    const state = input.engine.getSnapshot();
    const selectedActivations = selectPendingActivations(state);
    const selectedSubmits = selectPendingSubmits(state);
    const activationsChanged = selectedActivations !== lastPendingActivations;
    const submitsChanged = selectedSubmits !== lastPendingSubmits;
    lastPendingActivations = selectedActivations;
    lastPendingSubmits = selectedSubmits;
    if (!activationsChanged && !submitsChanged && turnContexts.size === 0) {
      return;
    }
    const pendingActivations = activationsChanged ? selectedActivations : [];
    const pendingSubmits = submitsChanged ? selectedSubmits : [];
    if (
      pendingActivations.length === 0 &&
      pendingSubmits.length === 0 &&
      turnContexts.size === 0
    ) {
      return;
    }
    const observedAtUnixMs = nowUnixMs();

    for (const activation of pendingActivations) {
      if (observedActivationRecords.has(activation)) continue;
      observedActivationRecords.add(activation);
      const startedAtUnixMs = performanceStartedAt(
        activation.submitDiagnostics?.submittedAtUnixMs,
        activation.requestedAtUnixMs
      );
      const hasInitialPrompt = (activation.content?.length ?? 0) > 0;
      const operationId =
        activation.mode === "new" && activation.clientSubmitId
          ? activation.clientSubmitId
          : activation.requestId;
      const attempt = hasInitialPrompt
        ? trackPromptAttempt({
            agentSessionId: activation.agentSessionId,
            allowUnboundTurnMatch: activation.mode === "new",
            operationId,
            queued: activation.submitDiagnostics?.queued === true,
            source: "activation",
            startedAtUnixMs,
            turnId: null
          })
        : null;
      if (activation.status !== "confirmed" && activation.status !== "failed") {
        continue;
      }
      const duration = agentGUIPerformanceDuration(
        observedAtUnixMs - startedAtUnixMs
      );
      const activationSettlementReady =
        activation.status === "failed" ||
        activation.commandOutcome !== "pending";
      if (
        activationSettlementReady &&
        !reportedActivationSettlements.has(activation.requestId)
      ) {
        remember(reportedActivationSettlements, activation.requestId);
        const commandDurationMs =
          activation.commandSettledAtUnixMs === null
            ? null
            : Math.max(
                0,
                activation.commandSettledAtUnixMs - activation.requestedAtUnixMs
              );
        const snapshotDurationMs =
          activation.snapshotObservedAtUnixMs === null
            ? null
            : Math.max(
                0,
                activation.snapshotObservedAtUnixMs -
                  activation.requestedAtUnixMs
              );
        emit({
          agentSessionId: activation.agentSessionId,
          ...duration,
          ...(commandDurationMs === null ? {} : { commandDurationMs }),
          commandOutcome: activation.commandOutcome,
          ...(activation.status === "failed"
            ? { errorCategory: activation.errorCode ?? "runtime" }
            : {}),
          hasInitialPrompt,
          lastObservedStage: activation.lastObservedStage,
          mode: activation.mode,
          observedAtUnixMs,
          operationId: activation.requestId,
          outcome: activation.status,
          provider: providerFor(state, activation.agentSessionId),
          ...(snapshotDurationMs === null ? {} : { snapshotDurationMs }),
          snapshotOutcome: activation.snapshotOutcome,
          startedAtUnixMs,
          type: "session_activation_settled",
          workspaceId
        });
      }
      if (hasInitialPrompt && !reportedPromptSettlements.has(operationId)) {
        remember(reportedPromptSettlements, operationId);
        emit({
          agentSessionId: activation.agentSessionId,
          ...duration,
          ...(activation.status === "failed"
            ? { errorCategory: activation.errorCode ?? "runtime" }
            : {}),
          observedAtUnixMs,
          operationId,
          outcome: activation.status === "confirmed" ? "accepted" : "failed",
          provider: providerFor(state, activation.agentSessionId),
          queued: activation.submitDiagnostics?.queued === true,
          source: "activation",
          startedAtUnixMs,
          turnId: null,
          type: "prompt_admission_settled",
          workspaceId
        });
      }
      if (activation.status === "failed" && attempt) {
        removeAttempt(attempt);
      }
    }

    for (const submit of pendingSubmits) {
      if (observedSubmitRecords.has(submit)) continue;
      observedSubmitRecords.add(submit);
      const startedAtUnixMs = performanceStartedAt(
        submit.submitDiagnostics?.submittedAtUnixMs,
        submit.requestedAtUnixMs
      );
      const attempt = trackPromptAttempt({
        agentSessionId: submit.agentSessionId,
        allowUnboundTurnMatch: false,
        operationId: submit.clientSubmitId,
        queued: submit.submitDiagnostics?.queued === true,
        source: "submit",
        startedAtUnixMs,
        turnId: null
      });
      if (attempt && submit.turnId && attempt.turnId !== submit.turnId) {
        bindTurn(attempt, submit.turnId, state);
      }
      if (
        submit.status !== "accepted" &&
        submit.status !== "confirmed" &&
        submit.status !== "failed"
      ) {
        continue;
      }
      if (!reportedPromptSettlements.has(submit.clientSubmitId)) {
        remember(reportedPromptSettlements, submit.clientSubmitId);
        const duration = agentGUIPerformanceDuration(
          observedAtUnixMs - startedAtUnixMs
        );
        emit({
          agentSessionId: submit.agentSessionId,
          ...duration,
          ...(submit.status === "failed"
            ? { errorCategory: submit.errorCode ?? "runtime" }
            : {}),
          observedAtUnixMs,
          operationId: submit.clientSubmitId,
          outcome: submit.status === "failed" ? "failed" : "accepted",
          provider: providerFor(state, submit.agentSessionId),
          queued: submit.submitDiagnostics?.queued === true,
          source: "submit",
          startedAtUnixMs,
          turnId: submit.turnId,
          type: "prompt_admission_settled",
          workspaceId
        });
      }
      if (submit.status === "failed" && attempt) {
        removeAttempt(attempt);
      }
    }

    for (const context of turnContexts.values()) {
      const turn = selectEngineTurn(
        state,
        context.agentSessionId,
        context.turnId
      );
      if (!turn) continue;
      const key = performanceTurnKey(turn.agentSessionId, turn.turnId);
      if (
        turn.phase !== "settled" ||
        !turn.outcome ||
        reportedTurnSettlements.has(key)
      ) {
        continue;
      }
      remember(reportedTurnSettlements, key);
      const settledAtUnixMs = turn.settledAtUnixMs ?? turn.updatedAtUnixMs;
      const duration = agentGUIPerformanceDuration(
        settledAtUnixMs - turn.startedAtUnixMs
      );
      emit({
        agentSessionId: turn.agentSessionId,
        ...duration,
        ...(turn.outcome === "failed"
          ? { errorCategory: turn.error?.code ?? "runtime" }
          : {}),
        observedAtUnixMs,
        operationId: context.operationId,
        outcome: turn.outcome,
        provider: providerFor(state, turn.agentSessionId),
        source: context.source,
        startedAtUnixMs: turn.startedAtUnixMs,
        turnId: turn.turnId,
        type: "turn_settled",
        workspaceId
      });
      const attempt = attemptsByTurnKey.get(key);
      if (attempt) removeAttempt(attempt);
      observationsByTurnKey.delete(key);
      turnContexts.delete(key);
    }
  };

  const observeSessionEvent = (event: unknown): void => {
    if (disposed || attemptsByOperationId.size === 0) return;
    const observation = firstTokenObservation(event, workspaceId, nowUnixMs());
    if (!observation) return;
    const key = performanceTurnKey(
      observation.agentSessionId,
      observation.turnId
    );
    const state = input.engine.getSnapshot();
    const exactAttempt = attemptsByTurnKey.get(key);
    if (exactAttempt) {
      reportFirstToken(exactAttempt, observation, state);
      return;
    }
    const unboundActivationAttempts = [
      ...attemptsByOperationId.values()
    ].filter(
      (attempt) =>
        attempt.allowUnboundTurnMatch &&
        attempt.agentSessionId === observation.agentSessionId &&
        attempt.turnId === null
    );
    if (unboundActivationAttempts.length === 1) {
      reportFirstToken(unboundActivationAttempts[0]!, observation, state);
      return;
    }
    const hasUnboundSubmit = [...attemptsByOperationId.values()].some(
      (attempt) =>
        !attempt.allowUnboundTurnMatch &&
        attempt.agentSessionId === observation.agentSessionId &&
        attempt.turnId === null
    );
    if (hasUnboundSubmit && !observationsByTurnKey.has(key)) {
      observationsByTurnKey.set(key, observation);
      trimMap(observationsByTurnKey);
    }
  };

  reportState();
  const releaseEngine = input.engine.subscribe(reportState);
  const releaseSessionEvents =
    input.subscribeSessionEvents(observeSessionEvent);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseEngine();
      releaseSessionEvents();
      attemptsByOperationId.clear();
      attemptsByTurnKey.clear();
      observationsByTurnKey.clear();
      turnContexts.clear();
      seenPromptAttempts.clear();
      reportedActivationSettlements.clear();
      reportedPromptSettlements.clear();
      reportedTurnSettlements.clear();
    },
    trackComposerOptionsLoad(loadInput) {
      if (disposed) return loadInput.load();
      return trackAgentGUIComposerOptionsLoad({
        ...loadInput,
        createOperationId: input.createOperationId,
        nowUnixMs,
        onEvent: emit,
        workspaceId
      });
    }
  };
}

export async function trackAgentGUIComposerOptionsLoad(
  input: AgentGUIComposerOptionsPerformanceTrackerInput
): Promise<AgentActivityComposerOptions> {
  const nowUnixMs = input.nowUnixMs ?? Date.now;
  const startedAtUnixMs = safeNowUnixMs(nowUnixMs);
  const operationId = composerOptionsOperationId(input, startedAtUnixMs);
  const agentTargetId = input.agentTargetId.trim();
  const force = input.force === true;
  const hasDirectory = Boolean(input.cwd?.trim());
  const provider = input.provider?.trim() || "unknown";
  emitPerformanceEvent(input.onEvent, {
    agentTargetId,
    force,
    hasDirectory,
    observedAtUnixMs: startedAtUnixMs,
    operationId,
    provider,
    source: input.source,
    startedAtUnixMs,
    type: "composer_options_load_started",
    workspaceId: input.workspaceId
  });

  let options: AgentActivityComposerOptions;
  try {
    options = await input.load();
  } catch (error) {
    const observedAtUnixMs = safeNowUnixMs(nowUnixMs);
    emitPerformanceEvent(input.onEvent, {
      agentTargetId,
      ...agentGUIPerformanceDuration(observedAtUnixMs - startedAtUnixMs),
      errorCategory: performanceErrorCategory(error),
      force,
      hasDirectory,
      observedAtUnixMs,
      operationId,
      outcome: "failed",
      provider,
      source: input.source,
      startedAtUnixMs,
      type: "composer_options_load_settled",
      workspaceId: input.workspaceId
    });
    throw error;
  }

  const observedAtUnixMs = safeNowUnixMs(nowUnixMs);
  emitPerformanceEvent(input.onEvent, {
    agentTargetId,
    ...agentGUIPerformanceDuration(observedAtUnixMs - startedAtUnixMs),
    force,
    hasDirectory,
    modelCount: Array.isArray(options.models) ? options.models.length : 0,
    observedAtUnixMs,
    operationId,
    outcome: "completed",
    provider: options.provider?.trim() || provider,
    source: input.source,
    startedAtUnixMs,
    type: "composer_options_load_settled",
    workspaceId: input.workspaceId
  });
  return options;
}

export function agentGUIPerformanceDuration(durationMs: number): {
  durationBucket: AgentGUIPerformanceDurationBucket;
  durationMs: number;
} {
  const normalizedDurationMs = Number.isFinite(durationMs)
    ? Math.max(0, durationMs)
    : 0;
  const durationBucket =
    normalizedDurationMs < 1_000
      ? "lt_1s"
      : normalizedDurationMs < 3_000
        ? "1s_to_3s"
        : normalizedDurationMs < 10_000
          ? "3s_to_10s"
          : normalizedDurationMs < 30_000
            ? "10s_to_30s"
            : normalizedDurationMs < 60_000
              ? "30s_to_60s"
              : "gte_60s";
  return { durationBucket, durationMs: normalizedDurationMs };
}

function firstTokenObservation(
  event: unknown,
  workspaceId: string,
  observedAtUnixMs: number
): FirstTokenObservation | null {
  const record = asRecord(event);
  if (stringField(record, "eventType") !== "message_delta") return null;
  const data = asRecord(record?.data);
  const eventWorkspaceId =
    stringField(record, "workspaceId") ?? stringField(data, "workspaceId");
  if (eventWorkspaceId !== workspaceId) return null;
  const role = stringField(data, "role")?.toLowerCase();
  if (role !== "assistant" && role !== "agent") return null;
  const content = asRecord(data?.content);
  if (!content || !deltaContentHasText(content)) return null;
  const agentSessionId =
    stringField(record, "agentSessionId") ??
    stringField(data, "agentSessionId");
  const turnId = stringField(data, "turnId") ?? stringField(record, "turnId");
  if (!agentSessionId || !turnId) return null;
  return {
    agentSessionId,
    firstTokenKind: normalizeFirstTokenKind(stringField(data, "kind")),
    observedAtUnixMs,
    turnId
  };
}

function deltaContentHasText(content: Record<string, unknown>): boolean {
  if (content.operation === "append_text") {
    return typeof content.text === "string" && content.text.trim().length > 0;
  }
  if (content.operation !== "set") return false;
  const pending: unknown[] = [content.value];
  let inspected = 0;
  while (pending.length > 0 && inspected < 100) {
    const value = pending.pop();
    inspected += 1;
    if (typeof value === "string" && value.trim()) return true;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    const record = asRecord(value);
    if (!record) continue;
    for (const key of ["text", "content", "value", "parts", "blocks"]) {
      if (Object.hasOwn(record, key)) pending.push(record[key]);
    }
  }
  return false;
}

function normalizeFirstTokenKind(
  kind: string | undefined
): AgentGUIFirstTokenKind {
  const normalized = kind?.trim().toLowerCase().replaceAll("-", "_");
  if (
    normalized === "text" ||
    normalized === "reasoning" ||
    normalized === "plan"
  ) {
    return normalized;
  }
  return "other";
}

function performanceStartedAt(
  submittedAtUnixMs: number | undefined,
  requestedAtUnixMs: number
): number {
  return typeof submittedAtUnixMs === "number" &&
    Number.isFinite(submittedAtUnixMs)
    ? submittedAtUnixMs
    : requestedAtUnixMs;
}

function turnContext(attempt: PromptAttempt, turnId: string): TurnContext {
  return {
    agentSessionId: attempt.agentSessionId,
    operationId: attempt.operationId,
    queued: attempt.queued,
    source: attempt.source,
    startedAtUnixMs: attempt.startedAtUnixMs,
    turnId
  };
}

function performanceTurnKey(agentSessionId: string, turnId: string): string {
  return `${agentSessionId}\u0000${turnId}`;
}

function performanceErrorCategory(error: unknown): string {
  const record = asRecord(error);
  const candidate =
    stringField(record, "code") ??
    (error instanceof Error ? error.name : undefined) ??
    "unknown";
  const normalized = candidate
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return normalized || "unknown";
}

function composerOptionsOperationId(
  input: Pick<
    AgentGUIComposerOptionsPerformanceTrackerInput,
    "createOperationId"
  >,
  startedAtUnixMs: number
): string {
  const fallback = `composer-options:${startedAtUnixMs}:${Math.random()
    .toString(36)
    .slice(2)}`;
  try {
    return input.createOperationId?.().trim() || fallback;
  } catch {
    return fallback;
  }
}

function safeNowUnixMs(nowUnixMs: () => number): number {
  try {
    const value = nowUnixMs();
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function emitPerformanceEvent<TEvent extends AgentGUIPerformanceEvent>(
  onEvent: (event: TEvent) => void,
  event: TEvent
): void {
  try {
    onEvent(event);
  } catch (error) {
    // Performance reporting must never affect the Agent runtime.
    console.error("[agent-gui] performance event sink failed", error);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  value: Record<string, unknown> | null,
  key: string
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function remember(set: Set<string>, key: string): void {
  set.add(key);
  while (set.size > MAX_RETAINED_PERFORMANCE_RECORDS) {
    const oldest = set.values().next().value;
    if (typeof oldest !== "string") break;
    set.delete(oldest);
  }
}

function trimMap<TKey, TValue>(map: Map<TKey, TValue>): void {
  while (map.size > MAX_RETAINED_PERFORMANCE_RECORDS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
