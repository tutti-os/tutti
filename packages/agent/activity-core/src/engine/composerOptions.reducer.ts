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
    inFlightCommandId: commandId
  };
  return {
    commands: [
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
    return changed(
      replaceEntry(state, targetKey, {
        ...current,
        status: "error",
        loadingSignature: null,
        inFlightCommandId: null
      })
    );
  }
  const options = composerOptionsFromValue(intent.value);
  if (!options) {
    return changed(
      replaceEntry(state, targetKey, {
        ...current,
        status: "error",
        loadingSignature: null,
        inFlightCommandId: null
      })
    );
  }
  const settledEntry: ComposerOptionsEntry = {
    ...current,
    status: "ready",
    settledSignature: current.loadingSignature,
    loadingSignature: null,
    inFlightCommandId: null
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
