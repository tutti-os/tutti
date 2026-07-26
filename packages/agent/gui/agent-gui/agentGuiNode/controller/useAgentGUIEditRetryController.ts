import { useCallback, useMemo } from "react";
import {
  editRetryPresentationRecordsEqual,
  dispatchEditRetry,
  dispatchEditRetryRecovery,
  selectEditRetryPresentation,
  type AgentActivityEditRetryRecoveryAction
} from "@tutti-os/agent-activity-core";
import { useAgentActivityRuntime } from "../../../agentActivityRuntime";
import { useEngineSelector } from "../../../shared/engine/useEngineSelector";
import { projectAgentGUIEditRetryPresentation } from "../model/agentGUIEditRetryModel";

export function useAgentGUIEditRetryController(input: {
  agentSessionId: string | null;
  workspaceId: string;
}) {
  const runtime = useAgentActivityRuntime();
  const sessionEngine = runtime.getSessionEngine(input.workspaceId);
  const record = useEngineSelector(
    sessionEngine,
    (state) => selectEditRetryPresentation(state, input.agentSessionId),
    editRetryPresentationRecordsEqual
  );

  const submit = useCallback(
    async (request: { editedText: string; turnId: string }) => {
      const agentSessionId = input.agentSessionId?.trim() ?? "";
      if (
        !agentSessionId ||
        record.availability?.eligible !== true ||
        record.availability.turnId !== request.turnId
      ) {
        return false;
      }
      try {
        await dispatchEditRetry(sessionEngine, {
          agentSessionId,
          editedText: request.editedText,
          turnId: request.turnId,
          workspaceId: input.workspaceId
        });
        return true;
      } catch {
        // The engine retains the typed failure/recovery state. Returning false
        // keeps the editor draft available without leaking a rejected UI event.
        return false;
      }
    },
    [
      input.agentSessionId,
      input.workspaceId,
      record.availability,
      sessionEngine
    ]
  );

  const recover = useCallback(
    async (action: AgentActivityEditRetryRecoveryAction) => {
      const agentSessionId = input.agentSessionId?.trim() ?? "";
      if (
        !agentSessionId ||
        !record.availability?.operationId ||
        !record.availability.availableActions.includes(action)
      ) {
        throw new Error("agent_edit_retry_recovery_unavailable");
      }
      await dispatchEditRetryRecovery(sessionEngine, {
        action,
        agentSessionId,
        workspaceId: input.workspaceId
      });
    },
    [
      input.agentSessionId,
      input.workspaceId,
      record.availability,
      sessionEngine
    ]
  );

  const presentation = useMemo(
    () =>
      projectAgentGUIEditRetryPresentation({
        availability: record.availability,
        commandStatus: record.operation.status
      }),
    [record.availability, record.operation.status]
  );

  return { presentation, recover, submit };
}
