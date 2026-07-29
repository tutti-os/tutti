import type {
  AgentActivityComposerOptions,
  AgentActivitySessionCapabilities
} from "./types.ts";
export {
  AGENT_CAPABILITY_KEYS,
  type AgentCapabilityKey
} from "./generated/agentCapabilityKeys.ts";
import {
  AGENT_CAPABILITY_KEYS,
  type AgentCapabilityKey
} from "./generated/agentCapabilityKeys.ts";

export interface AgentActivityCapabilityInput {
  composerOptions?: AgentActivityComposerOptions | null;
  sessionCapabilities?: Partial<Record<AgentCapabilityKey, boolean>> | null;
}

export function resolveAgentActivityCapability(
  key: AgentCapabilityKey,
  input: AgentActivityCapabilityInput
): boolean | null {
  const sessionValue = input.sessionCapabilities?.[key];
  if (typeof sessionValue === "boolean") return sessionValue;
  const composerValue = input.composerOptions?.capabilities?.[key];
  return typeof composerValue === "boolean" ? composerValue : null;
}

export function hasAgentCapability(
  capabilities: Partial<Record<AgentCapabilityKey, boolean>> | null | undefined,
  key: AgentCapabilityKey
): boolean {
  return capabilities?.[key] === true;
}

/**
 * Projects the canonical capability id list carried by session metadata into
 * the closed AgentActivity capability record consumed by AgentGUI.
 */
export function agentActivitySessionCapabilitiesFromIds(
  capabilities: readonly string[]
): AgentActivitySessionCapabilities {
  const capabilitySet = new Set(capabilities);
  return Object.fromEntries(
    AGENT_CAPABILITY_KEYS.map((capability) => [
      capability,
      capabilitySet.has(capability)
    ])
  ) as unknown as AgentActivitySessionCapabilities;
}
