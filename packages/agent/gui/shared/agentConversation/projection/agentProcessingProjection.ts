import { isLiveTurnLifecyclePhase } from "@tutti-os/agent-activity-core";
import type {
  WorkspaceAgentSessionDetailAgentItem,
  WorkspaceAgentSessionDetailTurn,
  WorkspaceAgentSessionDetailViewModel
} from "../../workspaceAgentSessionDetailViewModel";
import type { AgentProcessingRowVM } from "../contracts/agentProcessingRowVM";
import type { AgentTurnElapsedRowVM } from "../contracts/agentTurnElapsedRowVM";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";

export function projectAgentTurnTimingRow(
  detail: WorkspaceAgentSessionDetailViewModel,
  turn: WorkspaceAgentSessionDetailTurn
): AgentProcessingRowVM | AgentTurnElapsedRowVM | null {
  const startedAtUnixMs = turnStartedAtUnixMs(detail, turn);
  if (startedAtUnixMs === null) {
    return null;
  }
  if (isLiveTurn(detail, turn.id)) {
    return {
      kind: "processing",
      id: `processing:${turn.id}:elapsed`,
      turnId: turn.id,
      occurredAtUnixMs: startedAtUnixMs,
      startedAtUnixMs,
      completedAtUnixMs: null,
      live: true
    };
  }

  const completedAtUnixMs = turnCompletedAtUnixMs(detail, turn);
  if (completedAtUnixMs === null) {
    return null;
  }
  return {
    kind: "turn-elapsed",
    id: `turn-elapsed:${turn.id}`,
    turnId: turn.id,
    occurredAtUnixMs: startedAtUnixMs,
    startedAtUnixMs,
    completedAtUnixMs: Math.max(startedAtUnixMs, completedAtUnixMs)
  };
}

export function projectAgentProcessingRow(
  detail: WorkspaceAgentSessionDetailViewModel,
  rows: readonly AgentTranscriptRowVM[]
): AgentProcessingRowVM | null {
  if (!detail.showProcessingIndicator) {
    return null;
  }
  if (hasSpecificProgressRow(rows)) {
    return null;
  }
  const lifecycle = turnLifecycleWithTiming(detail);
  const turnId =
    lifecycle?.activeTurnId?.trim() || detail.turns.at(-1)?.id || null;
  const turn = turnId
    ? (detail.turns.find((candidate) => candidate.id === turnId) ??
      detail.turns.at(-1))
    : detail.turns.at(-1);
  return {
    kind: "processing",
    id: `processing:${turnId ?? "session"}`,
    turnId,
    occurredAtUnixMs:
      detail.session.updatedAtUnixMs ?? detail.session.createdAtUnixMs ?? null,
    startedAtUnixMs: processingStartedAtUnixMs(detail, lifecycle, turn),
    live: true
  };
}

function turnStartedAtUnixMs(
  detail: WorkspaceAgentSessionDetailViewModel,
  turn: WorkspaceAgentSessionDetailTurn
): number | null {
  const lifecycle = turnLifecycleWithTiming(detail);
  if (
    lifecycle?.activeTurnId?.trim() === turn.id ||
    isTurnLifecycleForSettledTurn(lifecycle, turn.id)
  ) {
    const lifecycleStartedAt = positiveUnixMs(lifecycle?.startedAtUnixMs);
    if (lifecycleStartedAt !== null) {
      return lifecycleStartedAt;
    }
  }

  const times: number[] = [];
  forEachTurnSourceTimelineItem(turn, (item) => {
    pushPositiveUnixMs(times, item.startedAtUnixMs);
  });
  pushPositiveUnixMs(times, turn.userMessage?.occurredAtUnixMs);
  for (const message of turn.userMessages) {
    pushPositiveUnixMs(times, message.occurredAtUnixMs);
  }

  return times.length > 0 ? Math.min(...times) : null;
}

function turnCompletedAtUnixMs(
  detail: WorkspaceAgentSessionDetailViewModel,
  turn: WorkspaceAgentSessionDetailTurn
): number | null {
  const lifecycle = turnLifecycleWithTiming(detail);
  if (isTurnLifecycleForSettledTurn(lifecycle, turn.id)) {
    const lifecycleCompletedAt = positiveUnixMs(lifecycle?.completedAtUnixMs);
    if (lifecycleCompletedAt !== null) {
      return lifecycleCompletedAt;
    }
  }

  const times: number[] = [];
  forEachTurnSourceTimelineItem(turn, (item) => {
    pushPositiveUnixMs(times, item.completedAtUnixMs);
  });
  collectTurnActivityEndTimes(turn, times);
  return times.length > 0 ? Math.max(...times) : null;
}

function collectTurnActivityEndTimes(
  turn: WorkspaceAgentSessionDetailTurn,
  times: number[]
): void {
  for (const message of turn.agentMessages) {
    pushMessageEndTime(times, message);
  }
  for (const call of turn.toolCalls) {
    pushMessageEndTime(times, call);
  }
  for (const item of turn.rawAgentItems ?? turn.agentItems) {
    switch (item.kind) {
      case "message":
        pushMessageEndTime(times, item.message);
        break;
      case "thinking":
        pushMessageEndTime(times, item.thinking);
        break;
      case "tool-calls":
        for (const call of item.toolCalls) {
          pushMessageEndTime(times, call);
        }
        for (const entry of item.groupEntries ?? []) {
          pushMessageEndTime(
            times,
            entry.kind === "thinking" ? entry.thinking : entry.call
          );
        }
        break;
    }
  }
}

function pushMessageEndTime(
  times: number[],
  item: {
    occurredAtUnixMs?: number | null;
    sourceTimelineItems?: Array<{
      occurredAtUnixMs?: number;
      createdAtUnixMs?: number;
      startedAtUnixMs?: number;
      completedAtUnixMs?: number;
    }>;
  }
): void {
  pushPositiveUnixMs(times, item.occurredAtUnixMs);
  for (const source of item.sourceTimelineItems ?? []) {
    pushPositiveUnixMs(times, source.completedAtUnixMs);
    pushPositiveUnixMs(times, source.occurredAtUnixMs);
    pushPositiveUnixMs(times, source.createdAtUnixMs);
    pushPositiveUnixMs(times, source.startedAtUnixMs);
  }
}

function forEachTurnSourceTimelineItem(
  turn: WorkspaceAgentSessionDetailTurn,
  visit: (item: {
    occurredAtUnixMs?: number;
    createdAtUnixMs?: number;
    startedAtUnixMs?: number;
    completedAtUnixMs?: number;
  }) => void
): void {
  for (const message of [...turn.userMessages, ...turn.agentMessages]) {
    for (const item of message.sourceTimelineItems ?? []) {
      visit(item);
    }
  }
  for (const call of turn.toolCalls) {
    for (const item of call.sourceTimelineItems ?? []) {
      visit(item);
    }
  }
  for (const item of turn.rawAgentItems ?? turn.agentItems) {
    forEachAgentItemSourceTimelineItem(item, visit);
  }
}

function forEachAgentItemSourceTimelineItem(
  item: WorkspaceAgentSessionDetailAgentItem,
  visit: (item: {
    occurredAtUnixMs?: number;
    createdAtUnixMs?: number;
    startedAtUnixMs?: number;
    completedAtUnixMs?: number;
  }) => void
): void {
  switch (item.kind) {
    case "message":
      for (const source of item.message.sourceTimelineItems ?? []) {
        visit(source);
      }
      break;
    case "thinking":
      for (const source of item.thinking.sourceTimelineItems ?? []) {
        visit(source);
      }
      break;
    case "tool-calls":
      for (const call of item.toolCalls) {
        for (const source of call.sourceTimelineItems ?? []) {
          visit(source);
        }
      }
      for (const entry of item.groupEntries ?? []) {
        const sourceItems =
          entry.kind === "thinking"
            ? entry.thinking.sourceTimelineItems
            : entry.call.sourceTimelineItems;
        for (const source of sourceItems ?? []) {
          visit(source);
        }
      }
      break;
  }
}

function processingStartedAtUnixMs(
  detail: WorkspaceAgentSessionDetailViewModel,
  lifecycle: ReturnType<typeof turnLifecycleWithTiming>,
  turn: WorkspaceAgentSessionDetailTurn | undefined
): number | null {
  if (lifecycle?.activeTurnId?.trim()) {
    return positiveUnixMs(lifecycle.startedAtUnixMs);
  }
  return (
    positiveUnixMs(turn?.userMessage?.occurredAtUnixMs) ??
    positiveUnixMs(turn?.userMessages[0]?.occurredAtUnixMs) ??
    positiveUnixMs(detail.session.createdAtUnixMs)
  );
}

function isTurnLifecycleForSettledTurn(
  lifecycle: ReturnType<typeof turnLifecycleWithTiming>,
  turnId: string
): boolean {
  return (
    lifecycle?.phase?.trim() === "settled" &&
    lifecycle.activeTurnId == null &&
    lifecycle.turnId?.trim() === turnId &&
    positiveUnixMs(lifecycle.completedAtUnixMs) !== null
  );
}

function isLiveTurn(
  detail: WorkspaceAgentSessionDetailViewModel,
  turnId: string
): boolean {
  const lifecycle = turnLifecycleWithTiming(detail);
  return (
    lifecycle?.activeTurnId?.trim() === turnId &&
    isLiveTurnLifecyclePhase(lifecycle.phase) &&
    (lifecycle.settling !== true ||
      positiveUnixMs(lifecycle.completedAtUnixMs) === null)
  );
}

function turnLifecycleWithTiming(detail: WorkspaceAgentSessionDetailViewModel):
  | {
      activeTurnId?: string | null;
      turnId?: string | null;
      phase?: string | null;
      settling?: boolean | null;
      startedAtUnixMs?: number | null;
      completedAtUnixMs?: number | null;
    }
  | null
  | undefined {
  return detail.session.turnLifecycle as
    | {
        activeTurnId?: string | null;
        turnId?: string | null;
        phase?: string | null;
        settling?: boolean | null;
        startedAtUnixMs?: number | null;
        completedAtUnixMs?: number | null;
      }
    | null
    | undefined;
}

function pushPositiveUnixMs(
  times: number[],
  value: number | null | undefined
): void {
  const time = positiveUnixMs(value);
  if (time !== null) {
    times.push(time);
  }
}

function positiveUnixMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function hasSpecificProgressRow(
  rows: readonly AgentTranscriptRowVM[]
): boolean {
  return rows.some((row) => {
    if (row.kind !== "tool-group") {
      return false;
    }
    return row.calls.some(
      (call) => call.statusKind === "working" || call.statusKind === "waiting"
    );
  });
}
