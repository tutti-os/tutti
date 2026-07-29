import { normalizeAgentActivityCapabilityReferences } from "@tutti-os/agent-activity-core";
import type {
  AgentComposerSubmitOptions,
  AgentComposerTuttiModeSubmitSnapshot
} from "./AgentComposer.types";

export function withAgentComposerTuttiModeSnapshot(input: {
  options?: AgentComposerSubmitOptions;
  active: boolean;
  effect: number;
  speed: number;
}): AgentComposerSubmitOptions {
  const tuttiMode: AgentComposerTuttiModeSubmitSnapshot = {
    active: input.active,
    ...(input.active ? { effect: input.effect, speed: input.speed } : {})
  };
  return {
    ...input.options,
    tuttiMode,
    ...(input.active
      ? {
          capabilityRefs: normalizeAgentActivityCapabilityReferences([
            ...(input.options?.capabilityRefs ?? []),
            { capability: "tutti", source: "slash_command" }
          ])
        }
      : {})
  };
}
