import { normalizeAgentActivityCapabilityReferences } from "@tutti-os/agent-activity-core";
import type {
  AgentComposerSubmitOptions,
  AgentComposerTuttiModeSubmitSnapshot
} from "./AgentComposer.types";

export function withAgentComposerTuttiModeSnapshot(input: {
  options?: AgentComposerSubmitOptions;
  active: boolean;
  orchestrationIntensity: number;
}): AgentComposerSubmitOptions {
  const tuttiMode: AgentComposerTuttiModeSubmitSnapshot = {
    active: input.active,
    ...(input.active
      ? { orchestrationIntensity: input.orchestrationIntensity }
      : {})
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
