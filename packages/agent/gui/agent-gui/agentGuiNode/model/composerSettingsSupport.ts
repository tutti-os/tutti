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
  modelSwitch: boolean;
}

/**
 * Derives which composer settings the active provider supports from the
 * daemon-provided composer options and the live session capabilities. This is
 * the single GUI-side answer to "what does this provider's composer show" —
 * the backend (tuttid composer options + adapter capability reporting) is the
 * source of truth, and the daemon clamps persisted values on its side.
 */
export interface AgentComposerModelPlanBinding {
  id: string;
  name: string;
  protocol?: string | null;
}

/**
 * Pure parse of the composer options `runtimeContext.modelPlan` payload
 * (`{ id, name, protocol }`) advertised for plan-bound targets. Returns null
 * for absent or malformed payloads so the composer degrades to the
 * provider-native model source presentation.
 */
export function composerModelPlanFromRuntimeContext(
  runtimeContext: Record<string, unknown> | null | undefined
): AgentComposerModelPlanBinding | null {
  const raw = runtimeContext?.modelPlan;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!id || !name) {
    return null;
  }
  const protocol =
    typeof record.protocol === "string" && record.protocol.trim()
      ? record.protocol.trim()
      : null;
  return { id, name, protocol };
}

export function composerSettingsSupportFromOptions(
  composerOptions: AgentActivityComposerOptions | null,
  sessionCapabilities: Partial<AgentActivitySessionCapabilities> | null
): AgentComposerSettingsSupport {
  const hasModelReasoningOptions = Object.values(
    composerOptions?.reasoningOptionsByModel ?? {}
  ).some((profile) => profile.options.length > 0);
  return {
    model: composerOptions?.modelConfigurable ?? false,
    reasoning:
      (composerOptions?.reasoningConfigurable ?? false) ||
      hasModelReasoningOptions,
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
      }) === true,
    modelSwitch:
      resolveAgentActivityCapability("modelSwitch", {
        composerOptions,
        sessionCapabilities
      }) === true
  };
}
