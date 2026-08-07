import type { WorkspaceAgentSessionDetailViewModel } from "../../workspaceAgentSessionDetailViewModel";
import type {
  AgentProcessingRowVM,
  AgentProcessingRuntimeState
} from "../contracts/agentProcessingRowVM";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";

interface AgentProcessingProjectionOptions {
  hasPendingInteraction?: boolean;
  runtimeState?: AgentProcessingRuntimeState;
  submissionPhase?: "preparing" | "submitting" | null;
  submissionStartedAtUnixMs?: number | null;
}

export function projectAgentProcessingRow(
  detail: WorkspaceAgentSessionDetailViewModel,
  rows: readonly AgentTranscriptRowVM[],
  options: AgentProcessingProjectionOptions = {}
): AgentProcessingRowVM | null {
  const activeTurnId = detail.session.activeTurnId;
  const canonicalTurn = detail.sessionTurns?.find(
    (turn) => turn.turnId === activeTurnId
  );
  if (
    !detail.showProcessingIndicator &&
    !options.submissionPhase &&
    canonicalTurn?.phase === "settled" &&
    !hasActiveToolProgress(rows)
  ) {
    return null;
  }
  if (
    !detail.showProcessingIndicator &&
    !options.submissionPhase &&
    !canonicalTurn &&
    !hasActiveToolProgress(rows)
  ) {
    return null;
  }
  if (options.hasPendingInteraction || hasPendingInteractiveCard(rows)) {
    return null;
  }
  if (canonicalTurn?.phase === "settled") return null;

  const turnId =
    activeTurnId ?? canonicalTurn?.turnId ?? detail.turns.at(-1)?.id ?? null;
  const progressRows = turnId
    ? rows.filter((row) => row.turnId === turnId)
    : rows;
  const canonicalStartedAtUnixMs = canonicalTurn?.startedAtUnixMs ?? null;

  return {
    kind: "processing",
    id: `processing:${turnId ?? "session"}`,
    turnId,
    phase: processingPhase(
      options.runtimeState,
      options.submissionPhase,
      canonicalTurn?.phase ?? null,
      progressRows
    ),
    startedAtUnixMs:
      validUnixMs(options.submissionStartedAtUnixMs) ??
      earliestFiniteUnixMs([
        submittedAtUnixMs(progressRows, canonicalStartedAtUnixMs),
        canonicalStartedAtUnixMs
      ]) ??
      validUnixMs(detail.session.createdAtUnixMs),
    lastProgressAtUnixMs: latestProgressUnixMs(progressRows),
    occurredAtUnixMs:
      detail.session.updatedAtUnixMs ?? detail.session.createdAtUnixMs ?? null
  };
}

function hasActiveToolProgress(rows: readonly AgentTranscriptRowVM[]): boolean {
  return rows.some(
    (row) =>
      row.kind === "tool-group" &&
      row.calls.some(
        (call) => call.statusKind === "working" || call.statusKind === "waiting"
      )
  );
}

function processingPhase(
  runtimeState: AgentProcessingRuntimeState | undefined,
  submissionPhase: "preparing" | "submitting" | null | undefined,
  turnPhase: string | null,
  rows: readonly AgentTranscriptRowVM[]
): AgentProcessingRowVM["phase"] {
  if (runtimeState === "reconnecting") return "reconnecting";
  if (!turnPhase) {
    return (
      submissionPhase ?? (rows.length > 0 ? "waiting_response" : "preparing")
    );
  }
  if (turnPhase === "submitted") return "submitting";
  if (turnPhase === "waiting" || turnPhase === "settling") {
    return "waiting_continuation";
  }

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "tool-group") {
      const activeCall = [...row.calls]
        .reverse()
        .find(
          (call) =>
            call.statusKind === "working" || call.statusKind === "waiting"
        );
      if (activeCall) {
        return activeCall.statusKind === "waiting"
          ? "waiting_tool"
          : "using_tool";
      }
    }
    if (row?.kind === "message" && row.speaker === "assistant") {
      const activeThinking = [...row.thinking]
        .reverse()
        .find(
          (thinking) =>
            thinking.statusKind === "working" ||
            thinking.statusKind === "waiting"
        );
      if (activeThinking) return "thinking";
      if (row.messages.some((message) => message.body.trim())) {
        return "generating";
      }
    }
  }
  return "waiting_response";
}

function hasPendingInteractiveCard(
  rows: readonly AgentTranscriptRowVM[]
): boolean {
  return rows.some(
    (row) =>
      row.kind === "tool-group" &&
      row.calls.some(
        (call) =>
          call.statusKind === "waiting" &&
          Boolean(call.approval || call.askUserQuestion || call.planMode)
      )
  );
}

function latestProgressUnixMs(
  rows: readonly AgentTranscriptRowVM[]
): number | null {
  const values: Array<number | null | undefined> = [];
  for (const row of rows) {
    if (row.kind === "message" && row.speaker === "assistant") {
      values.push(
        ...row.messages.map((message) => message.occurredAtUnixMs),
        ...row.thinking.map((thinking) => thinking.occurredAtUnixMs)
      );
    } else if (row.kind === "tool-group") {
      values.push(...row.calls.map((call) => call.occurredAtUnixMs));
    }
  }
  return latestFiniteUnixMs(values);
}

function submittedAtUnixMs(
  rows: readonly AgentTranscriptRowVM[],
  canonicalStartedAtUnixMs: number | null
): number | null {
  const values: number[] = [];
  for (const row of rows) {
    if (row.kind !== "message" || row.speaker !== "user") continue;
    for (const message of row.messages) {
      for (const item of message.sourceTimelineItems ?? []) {
        const value = item.payload?.clientSubmittedAtUnixMs;
        if (
          typeof value === "number" &&
          Number.isFinite(value) &&
          value > 0 &&
          (canonicalStartedAtUnixMs === null ||
            value <= canonicalStartedAtUnixMs)
        ) {
          values.push(value);
        }
      }
    }
  }
  return values.length > 0 ? Math.min(...values) : null;
}

function earliestFiniteUnixMs(
  values: readonly (number | null | undefined)[]
): number | null {
  const finite = values.filter(
    (value): value is number => Number.isFinite(value) && (value as number) > 0
  );
  return finite.length > 0 ? Math.min(...finite) : null;
}

function validUnixMs(value: number | null | undefined): number | null {
  return Number.isFinite(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function latestFiniteUnixMs(
  values: readonly (number | null | undefined)[]
): number | null {
  const finite = values.filter(
    (value): value is number => Number.isFinite(value) && (value as number) > 0
  );
  return finite.length > 0 ? Math.max(...finite) : null;
}
