import type { AgentActivityTurn } from "@tutti-os/agent-activity-core";
import type {
  WorkspaceAgentSessionDetailMessage,
  WorkspaceAgentSessionDetailTurn
} from "./workspaceAgentSessionDetailViewModel";

export function projectCanonicalTurnErrors({
  turns,
  sessionTurns,
  provider,
  agentSessionId
}: {
  turns: Map<string, WorkspaceAgentSessionDetailTurn>;
  sessionTurns: readonly AgentActivityTurn[];
  provider: string;
  agentSessionId: string;
}): void {
  for (const canonicalTurn of sessionTurns) {
    if (
      canonicalTurn.outcome !== "failed" &&
      canonicalTurn.outcome !== "interrupted"
    ) {
      continue;
    }
    const detail = canonicalTurn.error?.message.trim() ?? "";
    if (!detail) {
      continue;
    }

    const turn = getOrCreateTurn(turns, canonicalTurn.turnId);
    if (turn.agentMessages.some((message) => message.visibleError)) {
      continue;
    }

    const matchingMessage = turn.agentMessages.find(
      (message) => message.body.trim() === detail
    );
    if (matchingMessage) {
      matchingMessage.status = "failed";
      matchingMessage.statusKind = "failed";
      matchingMessage.visibleError = visibleErrorFromCanonicalTurn(
        canonicalTurn,
        provider
      );
      continue;
    }

    const message: WorkspaceAgentSessionDetailMessage = {
      id: `turn-error:${agentSessionId}:${canonicalTurn.turnId}`,
      body: detail,
      status: "failed",
      statusKind: "failed",
      turnId: canonicalTurn.turnId,
      occurredAtUnixMs:
        canonicalTurn.settledAtUnixMs ?? canonicalTurn.updatedAtUnixMs,
      visibleError: visibleErrorFromCanonicalTurn(canonicalTurn, provider)
    };
    turn.agentMessages.push(message);
    turn.agentItems.push({ kind: "message", message });
  }
}

function getOrCreateTurn(
  turns: Map<string, WorkspaceAgentSessionDetailTurn>,
  turnId: string
): WorkspaceAgentSessionDetailTurn {
  const existing = turns.get(turnId);
  if (existing) {
    return existing;
  }
  const turn: WorkspaceAgentSessionDetailTurn = {
    id: turnId,
    userMessage: null,
    userMessages: [],
    agentMessages: [],
    toolCalls: [],
    toolCallCount: 0,
    hasFailedToolCall: false,
    agentItems: []
  };
  turns.set(turnId, turn);
  return turn;
}

function visibleErrorFromCanonicalTurn(
  turn: AgentActivityTurn,
  provider: string
): NonNullable<WorkspaceAgentSessionDetailMessage["visibleError"]> {
  return {
    code: turn.error?.code?.trim() || null,
    phase: "turn",
    provider: provider.trim() || null,
    detail: turn.error?.message.trim() || null,
    retryable: null
  };
}
