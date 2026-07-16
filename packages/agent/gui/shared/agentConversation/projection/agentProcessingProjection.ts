import type { WorkspaceAgentSessionDetailViewModel } from "../../workspaceAgentSessionDetailViewModel";
import type { AgentProcessingRowVM } from "../contracts/agentProcessingRowVM";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";
import { agentTranscriptRowHasPresentationKind } from "./agentTranscriptPresentation";

export function projectAgentProcessingRow(
  detail: WorkspaceAgentSessionDetailViewModel,
  rows: readonly AgentTranscriptRowVM[]
): AgentProcessingRowVM | null {
  if (!detail.showProcessingIndicator) {
    return null;
  }
  const turnId = detail.session.activeTurnId;
  const canonicalTurn = detail.sessionTurns?.find(
    (turn) => turn.turnId === turnId
  );
  if (
    canonicalTurn &&
    canonicalTurn.phase !== "settled" &&
    Number.isFinite(canonicalTurn.startedAtUnixMs)
  ) {
    if (turnId && hasTurnTimingHostRow(rows, turnId)) {
      return null;
    }
    return processingRow(detail, turnId);
  }
  if (turnId && hasSpecificProgressRow(rows, turnId)) {
    return null;
  }
  return processingRow(detail, turnId);
}

function processingRow(
  detail: WorkspaceAgentSessionDetailViewModel,
  turnId: string | null
): AgentProcessingRowVM {
  return {
    kind: "processing",
    id: `processing:${turnId ?? "session"}`,
    turnId,
    occurredAtUnixMs:
      detail.session.updatedAtUnixMs ?? detail.session.createdAtUnixMs ?? null
  };
}

function hasTurnTimingHostRow(
  rows: readonly AgentTranscriptRowVM[],
  activeTurnId: string
): boolean {
  return rows.some((row) => row.turnId === activeTurnId);
}

function hasSpecificProgressRow(
  rows: readonly AgentTranscriptRowVM[],
  activeTurnId: string
): boolean {
  return rows.some((row) => {
    if (row.turnId !== activeTurnId) {
      return false;
    }
    return (
      agentTranscriptRowHasPresentationKind(row, "specific-progress") ||
      (row.kind === "tool-group" &&
        row.calls.some(
          (call) =>
            call.statusKind === "working" || call.statusKind === "waiting"
        ))
    );
  });
}
