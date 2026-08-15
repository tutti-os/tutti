import type {
  AgentActivityComposerOptions,
  AgentActivityComposerSettings,
  AgentActivitySession
} from "../types.ts";
import type { ScopedSessionResultValidation } from "./commandResult.validation.ts";
import type {
  ComposerOptionsEntry,
  ComposerOptionsLoadRequestedIntent,
  ComposerOptionsSection,
  ComposerOptionsState
} from "./composerOptions.types.ts";
import type {
  EngineCommand,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";
import {
  areComposerOptionsEqual,
  cloneAgentActivityComposerOptions,
  composerOptionsRequestSignature
} from "./composerOptions.helpers.ts";

const NO_COMMANDS: readonly EngineCommand[] = [];

export function createInitialComposerOptionsState(): ComposerOptionsState {
  return {
    entriesByTargetKey: {},
    optionsByTargetKey: {},
    sectionEntriesByTargetKey: {},
    sectionOptionsByTargetKey: {}
  };
}

export function composerOptionsReducer(
  state: ComposerOptionsState,
  intent: EngineIntent,
  context: {
    settingsResultValidation?: ScopedSessionResultValidation | null;
  } = {}
): EngineReducerResult<ComposerOptionsState> {
  switch (intent.type) {
    case "composerOptions/loadRequested":
      return requestLoad(state, intent);
    case "composerOptions/invalidated":
      return invalidate(
        state,
        intent.providers,
        intent.targetKeys,
        intent.sections
      );
    case "engine/commandResult":
      if (intent.commandType === "composerOptions/load") {
        return settleLoad(state, intent);
      }
      return intent.commandType === "session/updateSettings"
        ? refreshAfterSettings(
            state,
            intent.commandId,
            context.settingsResultValidation ?? null
          )
        : unchanged(state);
    default:
      return unchanged(state);
  }
}

function refreshAfterSettings(
  state: ComposerOptionsState,
  settingsCommandId: string,
  validation: ScopedSessionResultValidation | null
): EngineReducerResult<ComposerOptionsState> {
  if (validation?.kind !== "valid") return unchanged(state);
  const session = validation.session;
  const targetKey = session.agentTargetId?.trim() ?? "";
  const current = state.optionsByTargetKey[targetKey];
  if (
    !targetKey ||
    current?.behavior.refreshModelOptionsAfterSettings !== true
  ) {
    return unchanged(state);
  }
  return requestLoad(state, {
    commandId: `composer-options:after-settings:${settingsCommandId}`,
    cwd: session.cwd,
    force: true,
    provider: session.provider,
    section: "core",
    settings: composerSettingsFromSession(session),
    targetKey,
    type: "composerOptions/loadRequested",
    workspaceId: session.workspaceId
  });
}

function composerSettingsFromSession(
  session: AgentActivitySession
): AgentActivityComposerSettings {
  const settings = session.settings;
  return {
    ...(settings.model !== undefined ? { model: settings.model } : {}),
    ...(settings.permissionModeId !== undefined
      ? { permissionModeId: settings.permissionModeId }
      : {}),
    ...(settings.planMode !== undefined ? { planMode: settings.planMode } : {}),
    ...(settings.reasoningEffort !== undefined
      ? { reasoningEffort: settings.reasoningEffort }
      : {}),
    ...(settings.speed !== undefined ? { speed: settings.speed } : {})
  };
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
  const section = intent.section;
  const signature = composerOptionsRequestSignature({
    provider,
    cwd: intent.cwd,
    settings: intent.settings
  });
  const current = entryFor(state, targetKey, section);
  if (current) {
    const cacheHit =
      !intent.force &&
      current.status === "ready" &&
      current.settledSignature === signature;
    const inFlightDuplicate =
      current.status === "loading" && current.loadingSignature === signature;
    if (cacheHit || inFlightDuplicate) return unchanged(state);
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
        correlationId: correlationKey(targetKey, section),
        targetKey,
        provider,
        workspaceId,
        ...(intent.cwd !== undefined ? { cwd: intent.cwd } : {}),
        ...(intent.waitForFreshModelCatalog
          ? { waitForFreshModelCatalog: true }
          : {}),
        ...(intent.section !== undefined ? { section: intent.section } : {}),
        ...(intent.settings !== undefined ? { settings: intent.settings } : {})
      }
    ],
    state: replaceEntry(state, targetKey, section, entry)
  };
}

function settleLoad(
  state: ComposerOptionsState,
  intent: Extract<EngineIntent, { type: "engine/commandResult" }>
): EngineReducerResult<ComposerOptionsState> {
  const { section, targetKey } = parseCorrelationKey(
    intent.correlationId?.trim() ?? ""
  );
  const current = entryFor(state, targetKey, section);
  if (!current || current.inFlightCommandId !== intent.commandId) {
    return unchanged(state);
  }
  const settledEntry = (
    status: ComposerOptionsEntry["status"]
  ): ComposerOptionsEntry => ({
    ...current,
    status,
    ...(status === "ready"
      ? { settledSignature: current.loadingSignature }
      : {}),
    loadingSignature: null,
    inFlightCommandId: null
  });
  if (intent.outcome !== "succeeded") {
    return changed(
      replaceEntry(state, targetKey, section, settledEntry("error"))
    );
  }
  const options = composerOptionsFromValue(intent.value);
  if (!options) {
    return changed(
      replaceEntry(state, targetKey, section, settledEntry("error"))
    );
  }
  const nextEntry = settledEntry("ready");
  if (!section) {
    const existing = state.optionsByTargetKey[targetKey];
    return changed({
      ...state,
      entriesByTargetKey: {
        ...state.entriesByTargetKey,
        [targetKey]: nextEntry
      },
      optionsByTargetKey:
        existing && areComposerOptionsEqual(existing, options)
          ? state.optionsByTargetKey
          : {
              ...state.optionsByTargetKey,
              [targetKey]: cloneAgentActivityComposerOptions(options)
            }
    });
  }
  const previous = state.optionsByTargetKey[targetKey];
  const merged = mergeSectionOptions(previous, options, section);
  const sectionOptions = {
    ...(state.sectionOptionsByTargetKey[targetKey] ?? {}),
    [section]: cloneAgentActivityComposerOptions(options)
  };
  const sectionEntries = {
    ...(state.sectionEntriesByTargetKey[targetKey] ?? {}),
    [section]: nextEntry
  };
  return changed({
    ...state,
    entriesByTargetKey:
      section === "core"
        ? { ...state.entriesByTargetKey, [targetKey]: nextEntry }
        : state.entriesByTargetKey,
    optionsByTargetKey: {
      ...state.optionsByTargetKey,
      [targetKey]: merged
    },
    sectionEntriesByTargetKey: {
      ...state.sectionEntriesByTargetKey,
      [targetKey]: sectionEntries
    },
    sectionOptionsByTargetKey: {
      ...state.sectionOptionsByTargetKey,
      [targetKey]: sectionOptions
    }
  });
}

function mergeSectionOptions(
  existing: AgentActivityComposerOptions | undefined,
  incoming: AgentActivityComposerOptions,
  section: ComposerOptionsSection
): AgentActivityComposerOptions {
  if (!existing) return cloneAgentActivityComposerOptions(incoming);
  if (section === "core") {
    return cloneAgentActivityComposerOptions({
      ...existing,
      ...incoming,
      skills: existing.skills,
      capabilityCatalog: existing.capabilityCatalog,
      commands: existing.commands,
      loadedAtUnixMs: incoming.loadedAtUnixMs
    });
  }
  return cloneAgentActivityComposerOptions({
    ...existing,
    capabilities: incoming.capabilities ?? existing.capabilities,
    commands: incoming.commands,
    skills: incoming.skills,
    capabilityCatalog: incoming.capabilityCatalog,
    slashCommandPolicy: incoming.slashCommandPolicy,
    loadedAtUnixMs: incoming.loadedAtUnixMs
  });
}

function invalidate(
  state: ComposerOptionsState,
  providers: readonly string[] | undefined,
  targetKeys: readonly string[] | undefined,
  sections: readonly ComposerOptionsSection[] | undefined
): EngineReducerResult<ComposerOptionsState> {
  const providerSet = providers?.length ? new Set(providers) : null;
  const targetKeySet = targetKeys?.length
    ? new Set(targetKeys.map((value) => value.trim()).filter(Boolean))
    : null;
  const sectionSet = sections?.length ? new Set(sections) : null;
  let next = state;
  for (const [targetKey, entry] of Object.entries(state.entriesByTargetKey)) {
    if (!matchesInvalidation(targetKey, entry, providerSet, targetKeySet))
      continue;
    next = replaceEntry(next, targetKey, undefined, invalidatedEntry(entry));
  }
  for (const [targetKey, entries] of Object.entries(
    state.sectionEntriesByTargetKey
  )) {
    for (const [section, entry] of Object.entries(entries)) {
      const typedSection = section as ComposerOptionsSection;
      if (sectionSet !== null && !sectionSet.has(typedSection)) continue;
      if (!matchesInvalidation(targetKey, entry, providerSet, targetKeySet))
        continue;
      next = replaceEntry(
        next,
        targetKey,
        typedSection,
        invalidatedEntry(entry)
      );
    }
  }
  return next === state ? unchanged(state) : changed(next);
}

function invalidatedEntry(entry: ComposerOptionsEntry): ComposerOptionsEntry {
  return {
    ...entry,
    settledSignature: null,
    loadingSignature: null,
    loadVersion: entry.loadVersion + 1
  };
}

function matchesInvalidation(
  targetKey: string,
  entry: ComposerOptionsEntry,
  providers: Set<string> | null,
  targetKeys: Set<string> | null
): boolean {
  return (
    (providers === null && targetKeys === null) ||
    providers?.has(entry.provider) === true ||
    targetKeys?.has(targetKey) === true
  );
}

function entryFor(
  state: ComposerOptionsState,
  targetKey: string,
  section: ComposerOptionsSection | undefined
): ComposerOptionsEntry | undefined {
  return section
    ? state.sectionEntriesByTargetKey[targetKey]?.[section]
    : state.entriesByTargetKey[targetKey];
}

function replaceEntry(
  state: ComposerOptionsState,
  targetKey: string,
  section: ComposerOptionsSection | undefined,
  entry: ComposerOptionsEntry
): ComposerOptionsState {
  if (!section) {
    return {
      ...state,
      entriesByTargetKey: { ...state.entriesByTargetKey, [targetKey]: entry }
    };
  }
  const sectionEntriesByTargetKey = {
    ...state.sectionEntriesByTargetKey,
    [targetKey]: {
      ...(state.sectionEntriesByTargetKey[targetKey] ?? {}),
      [section]: entry
    }
  };
  return {
    ...state,
    ...(section === "core"
      ? {
          entriesByTargetKey: {
            ...state.entriesByTargetKey,
            [targetKey]: entry
          }
        }
      : {}),
    sectionEntriesByTargetKey
  };
}

function correlationKey(
  targetKey: string,
  section: ComposerOptionsSection | undefined
): string {
  return section ? `${targetKey}::${section}` : targetKey;
}

function parseCorrelationKey(value: string): {
  section: ComposerOptionsSection | undefined;
  targetKey: string;
} {
  const separator = value.lastIndexOf("::");
  const suffix = separator >= 0 ? value.slice(separator + 2) : "";
  if (suffix === "core" || suffix === "capabilities") {
    return { section: suffix, targetKey: value.slice(0, separator) };
  }
  return { section: undefined, targetKey: value };
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
