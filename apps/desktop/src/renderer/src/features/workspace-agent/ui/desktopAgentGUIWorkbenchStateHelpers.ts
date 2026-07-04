import type { DesktopAgentComposerDefaults } from "@shared/preferences";
import {
  normalizeDesktopAgentGUINodeState,
  type DesktopAgentGUIComposerOverrides,
  type DesktopAgentGUINodeState,
  type DesktopAgentGUIProvider
} from "../desktopAgentGUINodeState.ts";

export function resolveDesktopAgentGUIProviderForAgentTarget(
  agentTargetId: string | null,
  providerTargets:
    | readonly {
        agentTargetId?: string | null;
        provider: DesktopAgentGUIProvider;
      }[]
    | undefined,
  fallbackProvider: DesktopAgentGUIProvider
): DesktopAgentGUIProvider {
  if (!agentTargetId) {
    return fallbackProvider;
  }
  const target = providerTargets?.find(
    (candidate) => candidate.agentTargetId === agentTargetId
  );
  if (target) {
    return target.provider;
  }
  if (agentTargetId === "local:codex") {
    return "codex";
  }
  if (agentTargetId === "local:claude-code") {
    return "claude-code";
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
  return Object.keys(composerOverrides).length > 0 ? composerOverrides : null;
}
