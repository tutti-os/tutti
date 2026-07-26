import type {
  TuttidClient,
  WorkspaceAgentEditRetryAvailability,
  WorkspaceAgentEditRetryResponse
} from "@tutti-os/client-tuttid-ts";
import type {
  AgentActivityEditRetryAvailability,
  AgentActivityEditRetryCommandResult,
  AgentActivityEditRetryInput,
  AgentActivityEditRetryResult,
  AgentActivityRecoverEditRetryInput
} from "@tutti-os/agent-activity-core";

export function editRetryAvailabilityFromTuttid(
  availability: WorkspaceAgentEditRetryAvailability
): AgentActivityEditRetryAvailability {
  return {
    supported: availability.supported,
    eligible: availability.eligible,
    ...(availability.turnId ? { turnId: availability.turnId } : {}),
    historyRevision: availability.historyRevision,
    recoveryState: availability.recoveryState,
    ...(availability.operationId
      ? { operationId: availability.operationId }
      : {}),
    availableActions: [...availability.availableActions],
    ...(availability.reasonCode ? { reasonCode: availability.reasonCode } : {})
  };
}

export function editRetryResultFromTuttid(
  result: WorkspaceAgentEditRetryResponse
): AgentActivityEditRetryResult {
  return {
    operationId: result.operationId,
    state: result.state,
    retractedTurnId: result.retractedTurnId,
    ...(result.replacementTurnId
      ? { replacementTurnId: result.replacementTurnId }
      : {}),
    historyRevision: result.historyRevision,
    ...(result.reasonCode ? { reasonCode: result.reasonCode } : {})
  };
}

interface WorkspaceAgentEditRetryDependencies {
  tuttidClient: Pick<TuttidClient, "editRetry" | "recoverEditRetry">;
}

export class WorkspaceAgentEditRetryOperations {
  private readonly dependencies: WorkspaceAgentEditRetryDependencies;

  constructor(dependencies: WorkspaceAgentEditRetryDependencies) {
    this.dependencies = dependencies;
  }

  async editRetry(
    input: AgentActivityEditRetryInput
  ): Promise<AgentActivityEditRetryCommandResult> {
    const response = await this.dependencies.tuttidClient.editRetry(
      input.workspaceId.trim(),
      input.agentSessionId.trim(),
      input.turnId,
      {
        clientOperationId: input.clientOperationId,
        editedText: input.editedText,
        expectedHistoryRevision: input.expectedHistoryRevision
      },
      { signal: input.signal }
    );
    return commandResult(response);
  }

  async recoverEditRetry(
    input: AgentActivityRecoverEditRetryInput
  ): Promise<AgentActivityEditRetryCommandResult> {
    const response = await this.dependencies.tuttidClient.recoverEditRetry(
      input.workspaceId.trim(),
      input.agentSessionId.trim(),
      input.operationId,
      { action: input.action },
      { signal: input.signal }
    );
    return commandResult(response);
  }
}

function commandResult(
  response: WorkspaceAgentEditRetryResponse
): AgentActivityEditRetryCommandResult {
  const result = editRetryResultFromTuttid(response);
  return {
    availability: {
      availableActions: [],
      eligible: false,
      historyRevision: result.historyRevision,
      operationId: result.operationId,
      recoveryState: result.state,
      supported: true
    },
    result
  };
}
