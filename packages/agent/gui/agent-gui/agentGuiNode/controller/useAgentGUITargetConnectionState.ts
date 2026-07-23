import { useMemo } from "react";
import type {
  AgentGUITargetConnectionSource,
  AgentGUITargetConnectionStatus
} from "../../../types";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";
import {
  AgentGUITargetConnectionController,
  type AgentGUITargetConnectionBinding
} from "./AgentGUITargetConnectionController";

export function useAgentGUITargetConnectionState(input: {
  agentTargetId?: string | null;
  source?: AgentGUITargetConnectionSource | null;
}): {
  blocked: boolean;
  visibleStatus: AgentGUITargetConnectionStatus | null;
} {
  const binding = useMemo<AgentGUITargetConnectionBinding>(
    () => ({
      getSnapshot: () => {
        const agentTargetId = input.agentTargetId?.trim() ?? "";
        return agentTargetId
          ? (input.source?.getConnectionStatus(agentTargetId) ?? null)
          : null;
      },
      subscribe: (listener) =>
        input.source?.subscribe(listener) ?? (() => undefined)
    }),
    [input.agentTargetId, input.source]
  );
  const status = useEngineSelector(
    binding,
    identityTargetConnectionStatus,
    Object.is
  );
  const controller = useMemo(
    () => new AgentGUITargetConnectionController({ source: binding }),
    [binding]
  );
  const visibleStatus = useEngineSelector(
    controller,
    identityTargetConnectionStatus,
    Object.is
  );
  return {
    blocked: status === "connecting" || status === "unavailable",
    visibleStatus
  };
}

function identityTargetConnectionStatus(
  status: AgentGUITargetConnectionStatus | null
): AgentGUITargetConnectionStatus | null {
  return status;
}
