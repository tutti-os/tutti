import type { AgentActivityTurn } from "@tutti-os/agent-activity-core";
import type {
  WorkspaceAgentSessionDetailMessage,
  WorkspaceAgentSessionDetailTurn
} from "./workspaceAgentSessionDetailViewModel";

/**
 * Enriches Turns that the hydrated transcript has already projected.
 *
 * `sessionTurns` can describe the full session while `turns` contains only the
 * current message window. Canonical lifecycle metadata therefore must not
 * create transcript membership or alter transcript order.
 */
export function enrichProjectedTurnsWithCanonicalErrors({
  turns,
  sessionTurns,
  provider,
  agentSessionId
}: {
  turns: ReadonlyMap<string, WorkspaceAgentSessionDetailTurn>;
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

    const turn = turns.get(canonicalTurn.turnId);
    if (!turn) {
      continue;
    }
    const existingErrorMessage = turn.agentMessages.find(
      (message) => message.visibleError
    );
    if (existingErrorMessage) {
      const explicitDetail = canonicalTurn.error?.detail ?? "";
      if (explicitDetail.trim() && existingErrorMessage.visibleError) {
        existingErrorMessage.visibleError = {
          ...existingErrorMessage.visibleError,
          detail: explicitDetail,
          detailAvailable: true
        };
      }
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

function visibleErrorFromCanonicalTurn(
  turn: AgentActivityTurn,
  provider: string
): NonNullable<WorkspaceAgentSessionDetailMessage["visibleError"]> {
  const explicitDetail = turn.error?.detail ?? "";
  return {
    code: turn.error?.code?.trim() || null,
    phase: "turn",
    provider: provider.trim() || null,
    detail: explicitDetail || turn.error?.message.trim() || null,
    ...(explicitDetail.trim() ? { detailAvailable: true } : {}),
    retryable: null
  };
}
