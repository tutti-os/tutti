import type { AgentActivityTurn } from "@tutti-os/agent-activity-core";
import type {
  AgentMessageContentVM,
  AgentMessageRowVM
} from "../contracts/agentMessageRowVM";
import type { AgentTranscriptTurnGroup } from "./agentTranscriptModel";

export type AgentTurnTiming =
  | { kind: "live"; startedAtUnixMs: number }
  | {
      kind: "settled";
      elapsedSeconds: number;
      stages: AgentTurnStageTiming;
    };

export interface AgentTurnStageTiming {
  startupSeconds: number | null;
  firstResponseSeconds: number | null;
  generationSeconds: number | null;
  finalizationSeconds: number | null;
}

export type AgentTurnDuration =
  | { kind: "seconds"; seconds: number }
  | { kind: "minutes"; minutes: number }
  | { kind: "minutes-seconds"; minutes: number; seconds: number };

export type AgentTurnWorkSectionRow =
  AgentTranscriptTurnGroup["rows"][number] & {
    renderKey?: string;
  };

export interface AgentTurnWorkSectionSegment {
  kind: "visible" | "work";
  rows: AgentTurnWorkSectionRow[];
}

export interface AgentTurnWorkSectionModel {
  timing: AgentTurnTiming;
  leadingRows: AgentTurnWorkSectionRow[];
  sections: AgentTurnWorkSectionSegment[];
  collapseEligible: boolean;
}

interface AgentTurnWorkSectionOptions {
  collapseIntermediateAssistantReplies?: boolean;
}

export function resolveAgentTurnTiming(
  turn: AgentActivityTurn | null | undefined,
  isActiveTurn: boolean,
  submittedAtUnixMs?: number | null
): AgentTurnTiming | null {
  if (!turn || !Number.isFinite(turn.startedAtUnixMs)) {
    return null;
  }
  const timingStartedAtUnixMs =
    Number.isFinite(submittedAtUnixMs) &&
    (submittedAtUnixMs as number) <= turn.startedAtUnixMs
      ? (submittedAtUnixMs as number)
      : turn.startedAtUnixMs;

  if (turn.phase !== "settled") {
    return isActiveTurn
      ? { kind: "live", startedAtUnixMs: timingStartedAtUnixMs }
      : null;
  }

  const endUnixMs = turn.settledAtUnixMs;
  if (
    !Number.isFinite(endUnixMs) ||
    (endUnixMs as number) < timingStartedAtUnixMs
  ) {
    return null;
  }

  return {
    kind: "settled",
    elapsedSeconds: Math.max(
      0,
      Math.floor(((endUnixMs as number) - timingStartedAtUnixMs) / 1_000)
    ),
    stages: {
      startupSeconds: null,
      firstResponseSeconds: null,
      generationSeconds: null,
      finalizationSeconds: null
    }
  };
}

export function formatAgentTurnDuration(
  elapsedSeconds: number
): AgentTurnDuration {
  const safeSeconds = Math.max(0, Math.floor(elapsedSeconds));
  if (safeSeconds < 60) {
    return { kind: "seconds", seconds: safeSeconds };
  }

  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  if (seconds === 0) {
    return { kind: "minutes", minutes };
  }
  return { kind: "minutes-seconds", minutes, seconds };
}

export function buildAgentTurnWorkSectionModel(
  group: AgentTranscriptTurnGroup,
  turn: AgentActivityTurn | null | undefined,
  isActiveTurn = false,
  options: AgentTurnWorkSectionOptions = {}
): AgentTurnWorkSectionModel | null {
  const leadingRowCount = countLeadingUserRows(group.rows);
  const leadingRows = group.rows.slice(0, leadingRowCount);
  const submittedAtUnixMs = resolveTurnSubmittedAtUnixMs(
    leadingRows,
    turn?.startedAtUnixMs
  );
  const timing = resolveAgentTurnTiming(turn, isActiveTurn, submittedAtUnixMs);
  if (!timing) {
    return null;
  }

  const finalTarget = findFinalAssistantTextTarget(group.rows);
  if (timing.kind === "settled" && turn?.settledAtUnixMs != null) {
    timing.stages = resolveAgentTurnStageTiming(
      group.rows,
      leadingRowCount,
      finalTarget,
      submittedAtUnixMs,
      turn.startedAtUnixMs,
      turn.settledAtUnixMs
    );
  }
  const sections = buildOrderedSections(
    group.rows,
    leadingRowCount,
    finalTarget,
    options.collapseIntermediateAssistantReplies === true
  );
  const hasHiddenWork = sections.some(
    (section) => section.kind === "work" && section.rows.length > 0
  );
  const collapseEligible =
    finalTarget !== null &&
    turn?.phase === "settled" &&
    turn.outcome === "completed" &&
    hasHiddenWork &&
    !groupContainsBlockingMessage(group) &&
    !group.rows.some(({ row }) => row.kind === "generated-image");

  return {
    timing,
    leadingRows,
    sections,
    collapseEligible
  };
}

function resolveTurnSubmittedAtUnixMs(
  leadingRows: readonly AgentTurnWorkSectionRow[],
  fallbackUnixMs: number | null | undefined
): number | null {
  const exactTimestamps = leadingRows.flatMap(({ row }) => {
    if (row.kind !== "message" || row.speaker !== "user") {
      return [];
    }
    return row.messages.flatMap((message) =>
      (message.sourceTimelineItems ?? []).flatMap((item) => {
        const value = item.payload?.clientSubmittedAtUnixMs;
        return validUnixMs(value) ? [value] : [];
      })
    );
  });
  const exact = minimumTimestamp(exactTimestamps);
  if (exact !== null) {
    return exact;
  }

  const projected = minimumTimestamp(
    leadingRows.flatMap(({ row }) =>
      row.kind === "message" && row.speaker === "user"
        ? [
            row.occurredAtUnixMs,
            ...row.messages.map((message) => message.occurredAtUnixMs)
          ]
        : []
    )
  );
  return projected ?? (validUnixMs(fallbackUnixMs) ? fallbackUnixMs : null);
}

function resolveAgentTurnStageTiming(
  rows: readonly AgentTurnWorkSectionRow[],
  leadingRowCount: number,
  finalTarget: { rowIndex: number; messageIndex: number } | null,
  submittedAtUnixMs: number | null,
  turnStartedAtUnixMs: number,
  settledAtUnixMs: number
): AgentTurnStageTiming {
  const firstResponseAtUnixMs = minimumTimestamp(
    rows.slice(leadingRowCount).flatMap(({ row }) => {
      if (row.kind === "message" && row.speaker === "user") {
        return [];
      }
      return [row.occurredAtUnixMs];
    })
  );
  const finalRow =
    finalTarget === null ? null : rows[finalTarget.rowIndex]?.row;
  const finalMessage =
    finalRow?.kind === "message"
      ? finalRow.messages[finalTarget!.messageIndex]
      : null;
  const finalResponseAtUnixMs =
    minimumTimestamp(
      (finalMessage?.sourceTimelineItems ?? []).flatMap((item) =>
        validUnixMs(item.completedAtUnixMs) ? [item.completedAtUnixMs] : []
      )
    ) ??
    (validUnixMs(finalMessage?.occurredAtUnixMs)
      ? finalMessage.occurredAtUnixMs
      : firstResponseAtUnixMs);

  return {
    startupSeconds: elapsedStageSeconds(submittedAtUnixMs, turnStartedAtUnixMs),
    firstResponseSeconds: elapsedStageSeconds(
      turnStartedAtUnixMs,
      firstResponseAtUnixMs
    ),
    generationSeconds: elapsedStageSeconds(
      firstResponseAtUnixMs,
      finalResponseAtUnixMs
    ),
    finalizationSeconds: elapsedStageSeconds(
      finalResponseAtUnixMs,
      settledAtUnixMs
    )
  };
}

function elapsedStageSeconds(
  startedAtUnixMs: number | null,
  endedAtUnixMs: number | null
): number | null {
  if (
    !validUnixMs(startedAtUnixMs) ||
    !validUnixMs(endedAtUnixMs) ||
    endedAtUnixMs < startedAtUnixMs
  ) {
    return null;
  }
  return Math.max(0, Math.floor((endedAtUnixMs - startedAtUnixMs) / 1_000));
}

function minimumTimestamp(
  values: readonly (number | null | undefined)[]
): number | null {
  const valid = values.filter(validUnixMs);
  return valid.length > 0 ? Math.min(...valid) : null;
}

function validUnixMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function countLeadingUserRows(
  rows: readonly AgentTurnWorkSectionRow[]
): number {
  let count = 0;
  while (isUserMessageRow(rows[count]?.row)) {
    count += 1;
  }
  return count;
}

function buildOrderedSections(
  rows: readonly AgentTurnWorkSectionRow[],
  startIndex: number,
  finalTarget: { rowIndex: number; messageIndex: number } | null,
  collapseIntermediateAssistantReplies: boolean
): AgentTurnWorkSectionSegment[] {
  const sections: AgentTurnWorkSectionSegment[] = [];
  for (let rowIndex = startIndex; rowIndex < rows.length; rowIndex += 1) {
    const entry = rows[rowIndex]!;
    if (entry.row.kind === "message" && entry.row.speaker === "assistant") {
      if (!collapseIntermediateAssistantReplies) {
        appendAssistantMessageSections(sections, entry);
      } else if (finalTarget?.rowIndex === rowIndex) {
        appendFinalAssistantSections(sections, entry, finalTarget.messageIndex);
      } else {
        appendSectionRow(sections, "work", entry);
      }
      continue;
    }
    appendSectionRow(
      sections,
      isExplicitWorkRow(entry.row) ? "work" : "visible",
      entry
    );
  }
  return sections;
}

function appendFinalAssistantSections(
  sections: AgentTurnWorkSectionSegment[],
  sourceEntry: AgentTurnWorkSectionRow,
  finalMessageIndex: number
): void {
  const sourceRow = sourceEntry.row as AgentMessageRowVM;
  const messagesBeforeFinal = sourceRow.messages.slice(0, finalMessageIndex);
  const messagesAfterFinal = sourceRow.messages.slice(finalMessageIndex + 1);

  if (sourceRow.thinking.length > 0 || messagesBeforeFinal.length > 0) {
    appendSectionRow(sections, "work", {
      ...sourceEntry,
      renderKey: `${sourceRow.id}:turn-work-before`,
      row: cloneAssistantRow(sourceRow, messagesBeforeFinal, sourceRow.thinking)
    });
  }

  appendSectionRow(sections, "visible", {
    ...sourceEntry,
    renderKey: `${sourceRow.id}:turn-final`,
    row: cloneAssistantRow(
      sourceRow,
      [sourceRow.messages[finalMessageIndex]!],
      []
    )
  });

  if (messagesAfterFinal.length > 0) {
    appendSectionRow(sections, "work", {
      ...sourceEntry,
      renderKey: `${sourceRow.id}:turn-work-after`,
      row: cloneAssistantRow(sourceRow, messagesAfterFinal, [])
    });
  }
}

function appendAssistantMessageSections(
  sections: AgentTurnWorkSectionSegment[],
  sourceEntry: AgentTurnWorkSectionRow
): void {
  const sourceRow = sourceEntry.row as AgentMessageRowVM;
  const parts: Array<{
    kind: AgentTurnWorkSectionSegment["kind"];
    messages: AgentMessageContentVM[];
    thinking: AgentMessageRowVM["thinking"];
  }> = [];

  if (sourceRow.thinking.length > 0) {
    parts.push({ kind: "work", messages: [], thinking: sourceRow.thinking });
  }

  for (const message of sourceRow.messages) {
    const kind = isExplicitWorkMessage(message) ? "work" : "visible";
    const previous = parts.at(-1);
    if (previous?.kind === kind && previous.thinking.length === 0) {
      previous.messages.push(message);
      continue;
    }
    parts.push({ kind, messages: [message], thinking: [] });
  }

  if (parts.length === 0) {
    appendSectionRow(sections, "visible", sourceEntry);
    return;
  }

  if (parts.length === 1 && sourceRow.thinking.length === 0) {
    appendSectionRow(sections, parts[0]!.kind, sourceEntry);
    return;
  }

  parts.forEach((part, partIndex) => {
    appendSectionRow(sections, part.kind, {
      ...sourceEntry,
      renderKey: `${sourceRow.id}:turn-${part.kind}-${partIndex}`,
      row: cloneAssistantRow(sourceRow, part.messages, part.thinking)
    });
  });
}

function appendSectionRow(
  sections: AgentTurnWorkSectionSegment[],
  kind: AgentTurnWorkSectionSegment["kind"],
  row: AgentTurnWorkSectionRow
): void {
  const previous = sections.at(-1);
  if (previous?.kind === kind) {
    previous.rows.push(row);
    return;
  }
  sections.push({ kind, rows: [row] });
}

function findFinalAssistantTextTarget(
  rows: readonly AgentTurnWorkSectionRow[]
): { rowIndex: number; messageIndex: number } | null {
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = rows[rowIndex]?.row;
    if (row?.kind !== "message" || row.speaker !== "assistant") {
      continue;
    }
    for (
      let messageIndex = row.messages.length - 1;
      messageIndex >= 0;
      messageIndex -= 1
    ) {
      const message = row.messages[messageIndex];
      if (
        message?.isTurnFinalText &&
        message.body.trim() &&
        message.contentKind !== "image-grid" &&
        !message.visibleError &&
        !message.systemNotice
      ) {
        return { rowIndex, messageIndex };
      }
    }
  }
  return null;
}

function groupContainsBlockingMessage(
  group: AgentTranscriptTurnGroup
): boolean {
  return group.rows.some(
    ({ row }) =>
      row.kind === "message" &&
      row.messages.some((message) =>
        Boolean(
          message.visibleError ||
          (message.systemNotice && message.presentationKind === "content")
        )
      )
  );
}

function isExplicitWorkRow(row: AgentTurnWorkSectionRow["row"]): boolean {
  return (
    row.kind === "tool-group" ||
    row.kind === "turn-summary" ||
    row.kind === "processing"
  );
}

function isExplicitWorkMessage(message: AgentMessageContentVM): boolean {
  return (
    message.presentationKind === "specific-progress" ||
    message.presentationKind === "turn-boundary"
  );
}

function isUserMessageRow(
  row: AgentTurnWorkSectionRow["row"] | undefined
): row is AgentMessageRowVM {
  return row?.kind === "message" && row.speaker === "user";
}

function cloneAssistantRow(
  source: AgentMessageRowVM,
  messages: AgentMessageContentVM[],
  thinking: AgentMessageRowVM["thinking"]
): AgentMessageRowVM {
  return {
    ...source,
    messages,
    thinking
  };
}
