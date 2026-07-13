import {
  resolveAgentActivityCapability,
  type AgentActivityComposerOptions,
  type AgentActivitySessionCapabilities
} from "@tutti-os/agent-activity-core";

export interface AgentComposerSettingsSupport {
  model: boolean;
  reasoning: boolean;
  speed: boolean;
  permission: boolean;
  plan: boolean;
  browser: boolean;
  computer: boolean;
  planImplementation: boolean;
  permissionModeChangeDuringTurn: boolean;
  permissionModeChangeDeferred: boolean;
}

/**
 * Derives which composer settings the active provider supports from the
 * daemon-provided composer options and the live session capabilities. This is
 * the single GUI-side answer to "what does this provider's composer show" —
 * the backend (tuttid composer options + adapter capability reporting) is the
 * source of truth, and the daemon clamps persisted values on its side.
 */
export function composerSettingsSupportFromOptions(
  composerOptions: AgentActivityComposerOptions | null,
  sessionCapabilities: Partial<AgentActivitySessionCapabilities> | null
): AgentComposerSettingsSupport {
  return {
    model: composerOptions?.modelConfigurable ?? false,
    reasoning: composerOptions?.reasoningConfigurable ?? false,
    speed: composerOptions?.speedConfigurable ?? false,
    permission: composerOptions?.permissionConfig?.configurable ?? false,
    plan:
      resolveAgentActivityCapability("planMode", {
        composerOptions,
        sessionCapabilities
      }) === true,
    browser:
      resolveAgentActivityCapability("browserUse", {
        composerOptions,
        sessionCapabilities
      }) === true,
    computer:
      resolveAgentActivityCapability("computerUse", {
        composerOptions,
        sessionCapabilities
      }) === true,
    planImplementation:
      resolveAgentActivityCapability("planImplementation", {
        composerOptions,
        sessionCapabilities
      }) === true,
    permissionModeChangeDuringTurn:
      resolveAgentActivityCapability("permissionModeChangeDuringTurn", {
        composerOptions,
        sessionCapabilities
      }) === true,
    permissionModeChangeDeferred:
      resolveAgentActivityCapability("permissionModeChangeDeferred", {
        composerOptions,
        sessionCapabilities
      }) === true
  };
}
