import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import type {
  ComposerSettingsContext,
  ComposerSettingsDraft,
  ComposerSettingsCoreSnapshot,
  ComposerSettingsState
} from "./types.ts";

export function createComposerSettingsState(
  context: ComposerSettingsContext
): ComposerSettingsState {
  return {
    agentTargetId: context.agentTargetId.trim(),
    cwd: normalizeCwd(context.cwd),
    draft: {},
    fetchRevision: 0,
    settledRevision: 0,
    options: null,
    errorMessage: null
  };
}

/**
 * Target changes reset the draft and the loaded catalog: settings and models
 * are per-target facts and must not leak across targets. A cwd-only change
 * keeps the draft (project switches preserve explicit picks) but still
 * invalidates in-flight fetches via the caller-issued revision bump.
 */
export function applyContextChange(
  state: ComposerSettingsState,
  context: ComposerSettingsContext
): ComposerSettingsState {
  const agentTargetId = context.agentTargetId.trim();
  const cwd = normalizeCwd(context.cwd);
  if (agentTargetId === state.agentTargetId && cwd === state.cwd) {
    return state;
  }
  if (agentTargetId !== state.agentTargetId) {
    return {
      ...state,
      agentTargetId,
      cwd,
      draft: {},
      options: null,
      errorMessage: null
    };
  }
  return { ...state, cwd };
}

export function applyDraftPatch(
  state: ComposerSettingsState,
  patch: ComposerSettingsDraft
): ComposerSettingsState {
  return { ...state, draft: { ...state.draft, ...patch } };
}

export function issueFetch(
  state: ComposerSettingsState
): ComposerSettingsState {
  return { ...state, fetchRevision: state.fetchRevision + 1 };
}

/**
 * Fence: a response is applied only when it belongs to the newest issued
 * fetch. A slow stale response (typically the settings-less context load
 * racing a later with-settings refresh) settles nothing and mutates nothing.
 */
export function applyFetchResolved(
  state: ComposerSettingsState,
  revision: number,
  options: AgentActivityComposerOptions
): ComposerSettingsState {
  if (revision !== state.fetchRevision) {
    return state;
  }
  return { ...state, settledRevision: revision, options, errorMessage: null };
}

/** Settles the fence without options or error (no-target fetches). */
export function applyFetchResolvedEmpty(
  state: ComposerSettingsState,
  revision: number
): ComposerSettingsState {
  if (revision !== state.fetchRevision) {
    return state;
  }
  return { ...state, settledRevision: revision, errorMessage: null };
}

/** Failures settle the fence but keep the last good options. */
export function applyFetchFailed(
  state: ComposerSettingsState,
  revision: number,
  errorMessage: string
): ComposerSettingsState {
  if (revision !== state.fetchRevision) {
    return state;
  }
  return { ...state, settledRevision: revision, errorMessage };
}

export function projectComposerSettingsSnapshot(
  state: ComposerSettingsState
): ComposerSettingsCoreSnapshot {
  const refreshing = state.fetchRevision > state.settledRevision;
  return {
    agentTargetId: state.agentTargetId,
    cwd: state.cwd,
    draft: state.draft,
    options: state.options,
    refreshing,
    initialLoading: refreshing && state.options === null,
    degraded: state.errorMessage !== null,
    errorMessage: state.errorMessage,
    resolvedSettings: resolveComposerSettings(state.draft, state.options)
  };
}

/**
 * draft ⊕ effectiveSettings: every field the target supports becomes an
 * explicit value once options are loaded. This is both what the composer
 * displays and what a submission must carry.
 */
export function resolveComposerSettings(
  draft: ComposerSettingsDraft,
  options: AgentActivityComposerOptions | null
): ComposerSettingsDraft {
  const effective = options?.effectiveSettings ?? null;
  return {
    // effectiveSettings carries no browserUse; only an explicit pick applies.
    ...(draft.browserUse !== undefined ? { browserUse: draft.browserUse } : {}),
    ...resolveText("model", draft.model, effective?.model),
    ...resolveText(
      "permissionModeId",
      draft.permissionModeId,
      effective?.permissionModeId
    ),
    ...(draft.planMode !== undefined
      ? { planMode: draft.planMode }
      : typeof effective?.planMode === "boolean" && effective.planMode
        ? { planMode: effective.planMode }
        : {}),
    ...resolveText(
      "reasoningEffort",
      draft.reasoningEffort,
      effective?.reasoningEffort
    ),
    ...resolveText("speed", draft.speed, effective?.speed)
  };
}

function resolveText<
  Key extends "model" | "permissionModeId" | "reasoningEffort" | "speed"
>(
  key: Key,
  draftValue: string | null | undefined,
  effectiveValue: string | null | undefined
): Partial<Record<Key, string>> {
  const draft = draftValue?.trim();
  if (draft) {
    return { [key]: draft } as Partial<Record<Key, string>>;
  }
  const effective = effectiveValue?.trim();
  if (effective) {
    return { [key]: effective } as Partial<Record<Key, string>>;
  }
  return {};
}

function normalizeCwd(cwd: string | null): string | null {
  const normalized = cwd?.trim();
  return normalized ? normalized : null;
}
