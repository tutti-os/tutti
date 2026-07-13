import type { AgentActivityComposerOptions } from "./types.ts";
export {
  AGENT_CAPABILITY_KEYS,
  type AgentCapabilityKey
} from "./generated/agentCapabilityKeys.ts";
import type { AgentCapabilityKey } from "./generated/agentCapabilityKeys.ts";

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
