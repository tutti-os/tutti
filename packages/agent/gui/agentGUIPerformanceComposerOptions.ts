import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import type {
  AgentGUIComposerOptionsLoadSource,
  AgentGUIComposerOptionsPerformanceEvent,
  AgentGUIPerformanceDurationBucket,
  AgentGUIPerformanceEvent
} from "./agentGUIPerformanceEvents.ts";

const MAX_PERFORMANCE_DIMENSION_LENGTH = 80;
const MAX_MODEL_NAMES = 32;
const MAX_MODEL_NAME_LENGTH = 120;
const MAX_MODEL_NAMES_LENGTH = 1_024;

export interface AgentGUIComposerOptionsLoadInput {
  agentTargetId: string;
  cwd?: string | null;
  force?: boolean;
  load: () => Promise<AgentActivityComposerOptions>;
  section?: string | null;
  stage?: string | null;
  provider?: string | null;
  source: AgentGUIComposerOptionsLoadSource;
}

export interface AgentGUIComposerOptionsPerformanceTrackerInput extends AgentGUIComposerOptionsLoadInput {
  createOperationId?: () => string;
  nowUnixMs?: () => number;
  onEvent: (event: AgentGUIComposerOptionsPerformanceEvent) => void;
  workspaceId: string;
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
  const stage = composerOptionsStage(input.section, input.stage);
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
  if (stage) {
    emitPerformanceEvent(input.onEvent, {
      agentTargetId,
      force,
      hasDirectory,
      observedAtUnixMs: startedAtUnixMs,
      operationId,
      provider,
      section: stage.section,
      source: input.source,
      stage: stage.stage,
      startedAtUnixMs,
      type: "composer_options_stage_started",
      workspaceId: input.workspaceId
    });
  }

  let options: AgentActivityComposerOptions;
  try {
    options = await input.load();
  } catch (error) {
    const observedAtUnixMs = safeNowUnixMs(nowUnixMs);
    const errorFields = performanceErrorFieldsFromError(error);
    if (!isExpectedComposerOptionsCancellation(error)) {
      if (stage) {
        emitPerformanceEvent(input.onEvent, {
          agentTargetId,
          ...agentGUIPerformanceDuration(observedAtUnixMs - startedAtUnixMs),
          ...errorFields,
          failureStage: "options_load",
          force,
          hasDirectory,
          observedAtUnixMs,
          operationId,
          outcome: "failed",
          provider,
          section: stage.section,
          source: input.source,
          stage: stage.stage,
          startedAtUnixMs,
          type: "composer_options_stage_settled",
          workspaceId: input.workspaceId
        });
      }
      emitPerformanceEvent(input.onEvent, {
        agentTargetId,
        ...agentGUIPerformanceDuration(observedAtUnixMs - startedAtUnixMs),
        ...errorFields,
        failureStage: "options_load",
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
    } else if (stage) {
      emitPerformanceEvent(input.onEvent, {
        agentTargetId,
        ...agentGUIPerformanceDuration(observedAtUnixMs - startedAtUnixMs),
        force,
        hasDirectory,
        observedAtUnixMs,
        operationId,
        outcome: "failed",
        provider,
        section: stage.section,
        source: input.source,
        stage: stage.stage,
        startedAtUnixMs,
        type: "composer_options_stage_settled",
        workspaceId: input.workspaceId
      });
    }
    throw error;
  }

  const observedAtUnixMs = safeNowUnixMs(nowUnixMs);
  const modelNames = performanceModelNames(options.models);
  if (stage) {
    emitPerformanceEvent(input.onEvent, {
      agentTargetId,
      ...agentGUIPerformanceDuration(observedAtUnixMs - startedAtUnixMs),
      force,
      hasDirectory,
      ...(modelNames ? { modelNames } : {}),
      observedAtUnixMs,
      operationId,
      outcome: "completed",
      provider: options.provider?.trim() || provider,
      section: stage.section,
      source: input.source,
      stage: stage.stage,
      startedAtUnixMs,
      type: "composer_options_stage_settled",
      workspaceId: input.workspaceId
    });
  }
  emitPerformanceEvent(input.onEvent, {
    agentTargetId,
    ...agentGUIPerformanceDuration(observedAtUnixMs - startedAtUnixMs),
    force,
    hasDirectory,
    modelCount: Array.isArray(options.models) ? options.models.length : 0,
    ...(modelNames ? { modelNames } : {}),
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

export function emitPerformanceEvent<TEvent extends AgentGUIPerformanceEvent>(
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

function composerOptionsStage(
  section: string | null | undefined,
  stage: string | null | undefined
): { section: string; stage: string } | null {
  const normalizedSection = normalizePerformanceDimension(section);
  const normalizedStage = normalizePerformanceDimension(stage);
  return normalizedSection && normalizedStage
    ? { section: normalizedSection, stage: normalizedStage }
    : null;
}

function normalizePerformanceDimension(
  value: string | null | undefined
): string | undefined {
  const normalized = (value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_PERFORMANCE_DIMENSION_LENGTH);
  return normalized || undefined;
}

function performanceModelNames(
  models: AgentActivityComposerOptions["models"]
): string[] | undefined {
  const names: string[] = [];
  const seen = new Set<string>();
  let totalLength = 0;
  for (const model of models) {
    const name = normalizePerformanceModelName(model.value);
    if (!name || seen.has(name)) continue;
    if (
      names.length >= MAX_MODEL_NAMES ||
      totalLength + name.length > MAX_MODEL_NAMES_LENGTH
    ) {
      break;
    }
    names.push(name);
    seen.add(name);
    totalLength += name.length;
  }
  return names.length > 0 ? names : undefined;
}

function normalizePerformanceModelName(value: string): string | undefined {
  let withoutControls = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      continue;
    }
    withoutControls += character;
  }
  const normalized = withoutControls
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MODEL_NAME_LENGTH);
  return normalized || undefined;
}

function performanceErrorFieldsFromError(error: unknown): {
  errorCategory: string;
  errorCode: string;
} {
  const record = asRecord(error);
  const rawCode = stringField(record, "code") ?? "unknown";
  const errorCode = rawCode
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return {
    errorCategory: errorCode || "unknown",
    errorCode: errorCode || "unknown"
  };
}

function isExpectedComposerOptionsCancellation(error: unknown): boolean {
  const record = asRecord(error);
  const candidates = [
    stringField(record, "code"),
    error instanceof Error ? error.name : undefined,
    error instanceof Error ? error.message : undefined
  ]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
  return candidates.some((value) =>
    [
      "composer_options_load_aborted",
      "composer_options_load_superseded",
      "agent_session_engine_disposed"
    ].includes(value)
  );
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
