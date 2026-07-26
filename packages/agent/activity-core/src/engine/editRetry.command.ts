import type { AgentSessionEngine } from "./types.ts";
import type {
  AgentActivityEditRetryRecoveryAction,
  EditRetryOperationRecord
} from "./editRetry.types.ts";

export function dispatchEditRetry(
  engine: AgentSessionEngine,
  input: {
    agentSessionId: string;
    editedText: string;
    turnId: string;
    workspaceId: string;
  }
): Promise<EditRetryOperationRecord> {
  engine.dispatch({
    ...input,
    type: "editRetry/requested"
  });
  return waitForEditRetrySettlement(engine, input.agentSessionId);
}

export function dispatchEditRetryRecovery(
  engine: AgentSessionEngine,
  input: {
    action: AgentActivityEditRetryRecoveryAction;
    agentSessionId: string;
    workspaceId: string;
  }
): Promise<EditRetryOperationRecord> {
  engine.dispatch({
    ...input,
    type: "editRetry/recoveryRequested"
  });
  return waitForEditRetrySettlement(engine, input.agentSessionId);
}

function waitForEditRetrySettlement(
  engine: AgentSessionEngine,
  rawAgentSessionId: string
): Promise<EditRetryOperationRecord> {
  const agentSessionId = rawAgentSessionId.trim();
  const initial =
    engine.getSnapshot().editRetry.operationBySessionId[agentSessionId];
  const commandId = initial?.commandId;
  if (!commandId || initial.status !== "pending") {
    return Promise.reject(new Error("agent_edit_retry_command_not_started"));
  }
  return new Promise<EditRetryOperationRecord>((resolve, reject) => {
    const inspect = () => {
      const operation =
        engine.getSnapshot().editRetry.operationBySessionId[agentSessionId];
      if (
        operation?.commandId === commandId &&
        operation.status === "pending"
      ) {
        return;
      }
      unsubscribe();
      if (
        operation?.status === "succeeded" ||
        operation?.status === "reconciling"
      ) {
        resolve(operation);
        return;
      }
      reject(
        new Error(operation?.errorMessage ?? "agent_edit_retry_command_failed")
      );
    };
    const unsubscribe = engine.subscribe(inspect);
    inspect();
  });
}
