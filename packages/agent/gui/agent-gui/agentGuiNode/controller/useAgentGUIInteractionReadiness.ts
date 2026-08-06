import { useMemo } from "react";
import type {
  AgentGUIInteractionReadiness,
  AgentGUIInteractionReadinessIdentity,
  AgentGUIInteractionReadinessSource
} from "../../../types";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";

const SYNCHRONIZING: AgentGUIInteractionReadiness = {
  status: "blocked",
  reason: "synchronizing"
};

/** Reads one exact Host projection; a supplied-but-incomplete source fails closed. */
export function readAgentGUIInteractionReadiness(input: {
  identity: AgentGUIInteractionReadinessIdentity;
  source?: AgentGUIInteractionReadinessSource | null;
}): AgentGUIInteractionReadiness | null {
  if (!input.source) return null;
  return input.source.getInteractionReadiness(input.identity) ?? SYNCHRONIZING;
}

export function useAgentGUIInteractionReadiness(input: {
  identity: AgentGUIInteractionReadinessIdentity | null;
  required?: boolean;
  source?: AgentGUIInteractionReadinessSource | null;
}): AgentGUIInteractionReadiness | null {
  const binding = useMemo(
    () => ({
      getSnapshot: () =>
        input.identity
          ? readAgentGUIInteractionReadiness({
              identity: input.identity,
              source: input.source
            })
          : input.required && input.source
            ? SYNCHRONIZING
            : null,
      subscribe: (listener: () => void) =>
        input.source?.subscribe(listener) ?? (() => undefined)
    }),
    [input.identity, input.required, input.source]
  );
  return useEngineSelector(
    binding,
    identityInteractionReadiness,
    interactionReadinessEqual
  );
}

function identityInteractionReadiness(
  readiness: AgentGUIInteractionReadiness | null
): AgentGUIInteractionReadiness | null {
  return readiness;
}

function interactionReadinessEqual(
  left: AgentGUIInteractionReadiness | null,
  right: AgentGUIInteractionReadiness | null
): boolean {
  return (
    left?.status === right?.status &&
    (left?.status !== "blocked" ||
      (right?.status === "blocked" && left.reason === right.reason))
  );
}
