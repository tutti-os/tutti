import type { AgentActivityComposerOptions } from "../types.ts";
import type {
  EngineCommand,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import type {
  ComposerOptionsEntry,
  ComposerOptionsLoadRequestedIntent,
  ComposerOptionsState
} from "./composerOptions.types.ts";
import {
  areComposerOptionsEqual,
  cloneAgentActivityComposerOptions,
  composerOptionsRequestSignature
} from "./composerOptions.helpers.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];

/**
 * Bounded automatic retry for transient load failures. 4xx responses are
 * caller errors (stale/unknown target, bad request) and never retried; other
 * failures get a short backoff so one flaky daemon round trip does not strand
 * the composer in a permanent state.
 */
export const COMPOSER_OPTIONS_MAX_RETRIES = 2;
const COMPOSER_OPTIONS_RETRY_DELAYS_MS = [2_000, 8_000] as const;
const RETRY_EXPIRY_PREFIX = "composer-options-retry:";

function retryExpiryId(targetKey: string): string {
  return `${RETRY_EXPIRY_PREFIX}${targetKey}`;
}

export function createInitialComposerOptionsState(): ComposerOptionsState {
  return { optionsByTargetKey: {}, entriesByTargetKey: {} };
}

export function composerOptionsReducer(
  state: ComposerOptionsState,
  intent: EngineIntent
): EngineReducerResult<ComposerOptionsState> {
  switch (intent.type) {
    case "composerOptions/loadRequested":
      return requestLoad(state, intent);
    case "composerOptions/invalidated":
      return invalidate(state, intent.providers, intent.targetKeys);
    case "engine/commandResult":
      return intent.commandType === "composerOptions/load"
        ? settleLoad(state, intent)
        : unchanged(state);
    case "engine/intentExpired":
      return intent.expiryId.startsWith(RETRY_EXPIRY_PREFIX)
        ? issueScheduledRetry(
            state,
            intent.expiryId.slice(RETRY_EXPIRY_PREFIX.length)
          )
        : unchanged(state);
    default:
      return unchanged(state);
  }
}

function requestLoad(
  state: ComposerOptionsState,
  intent: ComposerOptionsLoadRequestedIntent
): EngineReducerResult<ComposerOptionsState> {
  const targetKey = intent.targetKey.trim();
  const provider = intent.provider.trim();
  const workspaceId = intent.workspaceId.trim();
  const commandId = intent.commandId.trim();
  if (!targetKey || !provider || !workspaceId || !commandId) {
    return unchanged(state);
  }
  const signature = composerOptionsRequestSignature({
    provider,
    cwd: intent.cwd,
    settings: intent.settings
  });
  const current = state.entriesByTargetKey[targetKey];
  if (!intent.force && current) {
    const cacheHit =
      current.status === "ready" && current.settledSignature === signature;
    const inFlightDuplicate =
      current.status === "loading" && current.loadingSignature === signature;
    if (cacheHit || inFlightDuplicate) {
      return unchanged(state);
    }
  }
  const entry: ComposerOptionsEntry = {
    status: "loading",
    provider,
    loadingSignature: signature,
    settledSignature: current?.settledSignature ?? null,
    loadVersion: (current?.loadVersion ?? 0) + 1,
    inFlightCommandId: commandId,
    retryCount: 0,
    retryPending: false,
    request: {
      workspaceId,
      ...(intent.cwd !== undefined ? { cwd: intent.cwd } : {}),
      ...(intent.settings !== undefined ? { settings: intent.settings } : {})
    }
  };
  return {
    commands: [
      // A user-driven request supersedes any scheduled automatic retry.
      ...(current?.retryPending
        ? [
            {
              type: "engine/cancelExpiry" as const,
              expiryId: retryExpiryId(targetKey)
            }
          ]
        : []),
      {
        type: "composerOptions/load",
        commandId,
        correlationId: targetKey,
        targetKey,
        provider,
        workspaceId,
        ...(intent.cwd !== undefined ? { cwd: intent.cwd } : {}),
        ...(intent.settings !== undefined ? { settings: intent.settings } : {})
      }
    ],
    state: replaceEntry(state, targetKey, entry)
  };
}

function settleLoad(
  state: ComposerOptionsState,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>
): EngineReducerResult<ComposerOptionsState> {
  const targetKey = intent.correlationId?.trim() ?? "";
  const current = state.entriesByTargetKey[targetKey];
  // A superseded load carries a stale commandId; ignore it so a late result
  // never clobbers a newer request. Invalidation deliberately keeps the active
  // command attached so its caller still receives a terminal result.
  if (!current || current.inFlightCommandId !== intent.commandId) {
    return unchanged(state);
  }
  if (intent.outcome !== "succeeded") {
    return settleFailure(state, targetKey, current, intent);
  }
  const options = composerOptionsFromValue(intent.value);
  if (!options) {
    return changed(replaceEntry(state, targetKey, errorEntry(current)));
  }
  const settledEntry: ComposerOptionsEntry = {
    ...current,
    status: "ready",
    settledSignature: current.loadingSignature,
    loadingSignature: null,
    inFlightCommandId: null,
    retryCount: 0,
    retryPending: false
  };
  const existing = state.optionsByTargetKey[targetKey];
  const optionsUnchanged = Boolean(
    existing && areComposerOptionsEqual(existing, options)
  );
  return changed({
    entriesByTargetKey: {
      ...state.entriesByTargetKey,
      [targetKey]: settledEntry
    },
    optionsByTargetKey: optionsUnchanged
      ? state.optionsByTargetKey
      : {
          ...state.optionsByTargetKey,
          [targetKey]: cloneAgentActivityComposerOptions(options)
        }
  });
}

function settleFailure(
  state: ComposerOptionsState,
  targetKey: string,
  current: ComposerOptionsEntry,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>
): EngineReducerResult<ComposerOptionsState> {
  const status4xx =
    intent.errorStatusCode !== undefined &&
    intent.errorStatusCode >= 400 &&
    intent.errorStatusCode < 500;
  const retryable =
    !status4xx &&
    current.request !== null &&
    current.retryCount < COMPOSER_OPTIONS_MAX_RETRIES;
  if (!retryable) {
    return changed(replaceEntry(state, targetKey, errorEntry(current)));
  }
  const delayMs =
    COMPOSER_OPTIONS_RETRY_DELAYS_MS[
      Math.min(current.retryCount, COMPOSER_OPTIONS_RETRY_DELAYS_MS.length - 1)
    ]!;
  return {
    commands: [
      {
        type: "engine/scheduleExpiry",
        expiryId: retryExpiryId(targetKey),
        dueAtUnixMs: 0,
        delayMs
      }
    ],
    state: replaceEntry(state, targetKey, {
      ...current,
      status: "loading",
      inFlightCommandId: null,
      retryCount: current.retryCount + 1,
      retryPending: true
    })
  };
}

function issueScheduledRetry(
  state: ComposerOptionsState,
  targetKey: string
): EngineReducerResult<ComposerOptionsState> {
  const current = state.entriesByTargetKey[targetKey];
  if (
    !current?.retryPending ||
    current.inFlightCommandId !== null ||
    current.request === null
  ) {
    return unchanged(state);
  }
  const commandId = `composer-options-retry:${targetKey}#${current.loadVersion + 1}`;
  return {
    commands: [
      {
        type: "composerOptions/load",
        commandId,
        correlationId: targetKey,
        targetKey,
        provider: current.provider,
        workspaceId: current.request.workspaceId,
        ...(current.request.cwd !== undefined
          ? { cwd: current.request.cwd }
          : {}),
        ...(current.request.settings !== undefined
          ? { settings: current.request.settings }
          : {})
      }
    ],
    state: replaceEntry(state, targetKey, {
      ...current,
      loadVersion: current.loadVersion + 1,
      inFlightCommandId: commandId,
      retryPending: false
    })
  };
}

function errorEntry(current: ComposerOptionsEntry): ComposerOptionsEntry {
  return {
    ...current,
    status: "error",
    loadingSignature: null,
    inFlightCommandId: null,
    retryPending: false
  };
}

function invalidate(
  state: ComposerOptionsState,
  providers: readonly string[] | undefined,
  targetKeys: readonly string[] | undefined
): EngineReducerResult<ComposerOptionsState> {
  const providerSet = providers?.length ? new Set(providers) : null;
  const targetKeySet = targetKeys?.length
    ? new Set(targetKeys.map((value) => value.trim()).filter(Boolean))
    : null;
  let entriesByTargetKey: Record<string, ComposerOptionsEntry> | null = null;
  for (const [targetKey, entry] of Object.entries(state.entriesByTargetKey)) {
    const matches =
      (providerSet === null && targetKeySet === null) ||
      providerSet?.has(entry.provider) === true ||
      targetKeySet?.has(targetKey) === true;
    if (!matches) continue;
    entriesByTargetKey ??= { ...state.entriesByTargetKey };
    entriesByTargetKey[targetKey] = {
      ...entry,
      // Drop cache validity so a subsequent request refetches. Keep an active
      // command attached: its caller still needs a terminal result, while the
      // cleared loading signature prevents a post-invalidation dedupe.
      settledSignature: null,
      loadingSignature: null,
      loadVersion: entry.loadVersion + 1
    };
  }
  return entriesByTargetKey
    ? changed({ ...state, entriesByTargetKey })
    : unchanged(state);
}

function composerOptionsFromValue(
  value: unknown
): AgentActivityComposerOptions | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AgentActivityComposerOptions>;
  return typeof candidate["provider"] === "string"
    ? (value as AgentActivityComposerOptions)
    : null;
}

function replaceEntry(
  state: ComposerOptionsState,
  targetKey: string,
  entry: ComposerOptionsEntry
): ComposerOptionsState {
  return {
    ...state,
    entriesByTargetKey: { ...state.entriesByTargetKey, [targetKey]: entry }
  };
}

function changed(
  state: ComposerOptionsState
): EngineReducerResult<ComposerOptionsState> {
  return { commands: NO_COMMANDS, state };
}

function unchanged(
  state: ComposerOptionsState
): EngineReducerResult<ComposerOptionsState> {
  return { commands: NO_COMMANDS, state };
}
