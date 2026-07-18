import type { DesktopAgentComposerDefaults } from "@shared/preferences";
import {
  normalizeDesktopAgentGUINodeState,
  type DesktopAgentGUIComposerOverrides,
  type DesktopAgentGUINodeState,
  type DesktopAgentGUIProvider
} from "../desktopAgentGUINodeState.ts";

export function resolveDesktopAgentGUIProviderForAgentTarget(
  agentTargetId: string | null,
  agents:
    | readonly {
        agentTargetId: string;
        provider: DesktopAgentGUIProvider;
      }[]
    | undefined,
  fallbackProvider: DesktopAgentGUIProvider
): DesktopAgentGUIProvider {
  if (!agentTargetId) {
    return fallbackProvider;
  }
  const target = agents?.find(
    (candidate) => candidate.agentTargetId === agentTargetId
  );
  if (target) {
    return target.provider;
  }
  return fallbackProvider;
}

export function withDesktopAgentGUIProviderComposerDefaults(
  state: DesktopAgentGUINodeState,
  provider: DesktopAgentGUIProvider,
  defaults: DesktopAgentComposerDefaults | null
): DesktopAgentGUINodeState {
  const agentTargetId = state.agentTargetId?.trim() || null;
  if (
    !defaults ||
    state.lastActiveAgentSessionId ||
    state.composerOverrides ||
    (agentTargetId &&
      state.composerOverridesByAgentTargetId?.[agentTargetId]) ||
    state.composerOverridesByProvider?.[provider]
  ) {
    return state;
  }

  const composerOverrides =
    desktopAgentComposerDefaultsToComposerOverrides(defaults);
  if (!composerOverrides) {
    return state;
  }

  return normalizeDesktopAgentGUINodeState(
    agentTargetId
      ? {
          ...state,
          composerOverridesByAgentTargetId: {
            ...(state.composerOverridesByAgentTargetId ?? {}),
            [agentTargetId]: composerOverrides
          }
        }
      : {
          ...state,
          composerOverrides,
          composerOverridesByProvider: {
            ...(state.composerOverridesByProvider ?? {}),
            [provider]: composerOverrides
          }
        },
    provider
  );
}

/**
 * Applies the workspace-scoped model-plan selection after global remembered
 * defaults have seeded the remaining composer settings. Provider-native
 * configurations intentionally keep using the global remembered model.
 */
export function withDesktopAgentGUIModelConfiguration(
  state: DesktopAgentGUINodeState
): DesktopAgentGUINodeState {
  const agentTargetId = state.agentTargetId?.trim() || null;
  if (!agentTargetId) {
    return state;
  }
  const configuration =
    state.modelConfigurationsByAgentTargetId?.[agentTargetId];
  if (configuration?.source !== "model-plan") {
    return state;
  }

  const model =
    configuration.selectedModel?.trim() ||
    configuration.defaultModel?.trim() ||
    null;
  const currentOverrides =
    state.composerOverridesByAgentTargetId?.[agentTargetId] ?? null;
  if ((currentOverrides?.model?.trim() || null) === model) {
    return state;
  }

  return normalizeDesktopAgentGUINodeState(
    {
      ...state,
      composerOverridesByAgentTargetId: {
        ...(state.composerOverridesByAgentTargetId ?? {}),
        [agentTargetId]: {
          ...(currentOverrides ?? {}),
          model
        }
      }
    },
    state.provider
  );
}

export function hasDesktopAgentGUIConversationRailCollapsedState(
  value: unknown
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { conversationRailCollapsed?: unknown })
      .conversationRailCollapsed === "boolean"
  );
}

function desktopAgentComposerDefaultsToComposerOverrides(
  defaults: DesktopAgentComposerDefaults
): DesktopAgentGUIComposerOverrides | null {
  const composerOverrides: DesktopAgentGUIComposerOverrides = {};
  if (defaults.model?.trim()) {
    composerOverrides.model = defaults.model.trim();
  }
  if (defaults.permissionModeId?.trim()) {
    composerOverrides.permissionModeId = defaults.permissionModeId.trim();
  }
  if (defaults.reasoningEffort?.trim()) {
    composerOverrides.reasoningEffort = defaults.reasoningEffort.trim();
  }
  if (defaults.speed?.trim()) {
    composerOverrides.speed = defaults.speed.trim();
  }
  return Object.keys(composerOverrides).length > 0 ? composerOverrides : null;
}
