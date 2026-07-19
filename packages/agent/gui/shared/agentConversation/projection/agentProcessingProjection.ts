import type {
  AgentActivityTurn,
  AgentActivityTurnPhase,
  AgentActivityTurnTokenUsage
} from "@tutti-os/agent-activity-core";
import type {
  WorkspaceAgentSessionDetailTurn,
  WorkspaceAgentSessionDetailViewModel
} from "../../workspaceAgentSessionDetailViewModel";
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
  const activeTurnId = detail.session.activeTurnId;
  const canonicalTurn = activeTurnId
    ? detail.sessionTurns?.find((turn) => turn.turnId === activeTurnId)
    : undefined;
  if (canonicalTurn && Number.isFinite(canonicalTurn.startedAtUnixMs)) {
    if (!isLiveProcessingPhase(canonicalTurn.phase)) {
      return null;
    }
    return canonicalProcessingRow(detail, canonicalTurn);
  }
  const fallbackTurnId = activeTurnId ?? detail.turns.at(-1)?.id ?? null;
  if (fallbackTurnId && hasSpecificProgressRow(rows, fallbackTurnId)) {
    return null;
  }
  return fallbackProcessingRow(detail, fallbackTurnId);
}

function isLiveProcessingPhase(phase: AgentActivityTurnPhase): boolean {
  return phase === "submitted" || phase === "running";
}

function canonicalProcessingRow(
  detail: WorkspaceAgentSessionDetailViewModel,
  turn: AgentActivityTurn
): AgentProcessingRowVM {
  const projectedTurn = detail.turns.find(
    (candidate) => candidate.id === turn.turnId
  );
  const streamingStartedAtUnixMs =
    latestInFlightMessageStartedAtUnixMs(projectedTurn);
  return {
    kind: "processing",
    id: `processing:${turn.turnId}`,
    turnId: turn.turnId,
    occurredAtUnixMs: fallbackOccurredAtUnixMs(detail),
    modelPhase: streamingStartedAtUnixMs === null ? "awaiting" : "streaming",
    phaseStartedAtUnixMs:
      streamingStartedAtUnixMs ??
      Math.max(
        turn.startedAtUnixMs,
        latestTurnActivityUnixMs(projectedTurn) ?? Number.NEGATIVE_INFINITY
      ),
    tokenUsage: tokenUsageForRow(detail, turn)
  };
}

function fallbackProcessingRow(
  detail: WorkspaceAgentSessionDetailViewModel,
  turnId: string | null
): AgentProcessingRowVM {
  const projectedTurn = turnId
    ? detail.turns.find((candidate) => candidate.id === turnId)
    : undefined;
  return {
    kind: "processing",
    id: `processing:${turnId ?? "session"}`,
    turnId,
    occurredAtUnixMs: fallbackOccurredAtUnixMs(detail),
    modelPhase: "awaiting",
    phaseStartedAtUnixMs: latestTurnActivityUnixMs(projectedTurn),
    tokenUsage: null
  };
}

function tokenUsageForRow(
  detail: WorkspaceAgentSessionDetailViewModel,
  turn: AgentActivityTurn
): AgentActivityTurnTokenUsage | null {
  if (detail.session.capabilities?.tokenUsage !== true || !turn.tokenUsage) {
    return null;
  }
  return {
    inputTokens: turn.tokenUsage.inputTokens,
    outputTokens: turn.tokenUsage.outputTokens
  };
}

function latestInFlightMessageStartedAtUnixMs(
  turn: WorkspaceAgentSessionDetailTurn | undefined
): number | null {
  if (!turn) {
    return null;
  }
  let latest: number | null = null;
  for (const item of turn.agentItems) {
    if (item.kind !== "message" && item.kind !== "thinking") {
      continue;
    }
    const entry = item.kind === "message" ? item.message : item.thinking;
    if (entry.statusKind !== "working") {
      continue;
    }
    const occurredAtUnixMs = finiteUnixMs(entry.occurredAtUnixMs);
    if (occurredAtUnixMs === null) {
      continue;
    }
    latest =
      latest === null ? occurredAtUnixMs : Math.max(latest, occurredAtUnixMs);
  }
  return latest;
}

function latestTurnActivityUnixMs(
  turn: WorkspaceAgentSessionDetailTurn | undefined
): number | null {
  if (!turn) {
    return null;
  }
  let latest: number | null = null;
  const track = (value: number | null | undefined) => {
    const occurredAtUnixMs = finiteUnixMs(value);
    if (occurredAtUnixMs !== null) {
      latest =
        latest === null ? occurredAtUnixMs : Math.max(latest, occurredAtUnixMs);
    }
  };
  for (const message of turn.userMessages) {
    track(message.completedAtUnixMs ?? message.occurredAtUnixMs);
  }
  for (const item of turn.agentItems) {
    if (item.kind === "tool-calls") {
      for (const call of item.toolCalls) {
        track(call.completedAtUnixMs ?? call.occurredAtUnixMs);
      }
      continue;
    }
    const entry = item.kind === "message" ? item.message : item.thinking;
    track(entry.completedAtUnixMs ?? entry.occurredAtUnixMs);
  }
  return latest;
}

function finiteUnixMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fallbackOccurredAtUnixMs(
  detail: WorkspaceAgentSessionDetailViewModel
): number | null {
  return (
    detail.session.updatedAtUnixMs ?? detail.session.createdAtUnixMs ?? null
  );
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
