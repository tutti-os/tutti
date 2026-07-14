import { cloneJSONValue } from "../activityValueParsing.ts";
import type {
  AgentActivityComposerOptions,
  AgentActivityComposerSettings
} from "../types.ts";

export function cloneAgentActivityComposerOptions(
  options: AgentActivityComposerOptions
): AgentActivityComposerOptions {
  return {
    provider: options.provider,
    capabilities: options.capabilities ? { ...options.capabilities } : null,
    models: options.models.map((option) => ({ ...option })),
    reasoningEfforts: options.reasoningEfforts.map((option) => ({ ...option })),
    reasoningOptionsByModel: options.reasoningOptionsByModel
      ? Object.fromEntries(
          Object.entries(options.reasoningOptionsByModel).map(
            ([model, profile]) => [
              model,
              {
                ...profile,
                options: profile.options.map((option) => ({ ...option }))
              }
            ]
          )
        )
      : undefined,
    speeds: (options.speeds ?? []).map((option) => ({ ...option })),
    modelConfigurable: options.modelConfigurable ?? false,
    reasoningConfigurable: options.reasoningConfigurable ?? false,
    speedConfigurable: options.speedConfigurable ?? false,
    effectiveSettings: options.effectiveSettings
      ? { ...options.effectiveSettings }
      : (options.effectiveSettings ?? null),
    permissionConfig: cloneJSONValue(
      options.permissionConfig ?? null
    ) as AgentActivityComposerOptions["permissionConfig"],
    draftAgentSessionId: options.draftAgentSessionId ?? null,
    modelOptionsLoading: options.modelOptionsLoading,
    skills: options.skills.map((skill) => ({ ...skill })),
    capabilityCatalog: (options.capabilityCatalog ?? []).map((capability) => ({
      ...capability
    })),
    behavior: { ...options.behavior },
    slashCommandPolicy: cloneJSONValue(
      options.slashCommandPolicy ?? null
    ) as AgentActivityComposerOptions["slashCommandPolicy"],
    loadedAtUnixMs: options.loadedAtUnixMs
  };
}

export function areComposerOptionsEqual(
  left: AgentActivityComposerOptions,
  right: AgentActivityComposerOptions
): boolean {
  const { loadedAtUnixMs: _leftLoadedAtUnixMs, ...leftComparable } = left;
  const { loadedAtUnixMs: _rightLoadedAtUnixMs, ...rightComparable } = right;
  return JSON.stringify(leftComparable) === JSON.stringify(rightComparable);
}

/**
 * Deterministic signature of a composer-options request. Two requests with the
 * same signature are interchangeable, so a settled result can satisfy a repeat
 * and an in-flight load can be deduplicated. Ported verbatim from the former
 * imperative cache coordinator.
 */
export function composerOptionsRequestSignature(input: {
  provider?: string;
  cwd?: string | null;
  settings?: AgentActivityComposerSettings | null;
}): string {
  const settings = input.settings;
  const normalizedText = (value: string | null | undefined): string | null =>
    value?.trim() || null;
  return JSON.stringify({
    provider: input.provider?.trim() ?? "",
    cwd: input.cwd?.trim() ?? "",
    settings: {
      model: normalizedText(settings?.model),
      reasoningEffort: normalizedText(settings?.reasoningEffort),
      speed: normalizedText(settings?.speed),
      planMode:
        typeof settings?.planMode === "boolean" ? settings.planMode : null,
      permissionModeId: normalizedText(settings?.permissionModeId)
    }
  });
}
