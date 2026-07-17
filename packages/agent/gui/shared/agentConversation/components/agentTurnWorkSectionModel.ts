import type { AgentActivityTurn } from "@tutti-os/agent-activity-core";
import type {
  AgentMessageContentVM,
  AgentMessageRowVM
} from "../contracts/agentMessageRowVM";
import type { AgentTranscriptTurnGroup } from "./agentTranscriptModel";

export type AgentTurnTiming =
  | { kind: "live"; startedAtUnixMs: number }
  | { kind: "settled"; elapsedSeconds: number };

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

export function resolveAgentTurnTiming(
  turn: AgentActivityTurn | null | undefined,
  isActiveTurn: boolean
): AgentTurnTiming | null {
  if (!turn || !Number.isFinite(turn.startedAtUnixMs)) {
    return null;
  }

  if (turn.phase !== "settled") {
    return isActiveTurn
      ? { kind: "live", startedAtUnixMs: turn.startedAtUnixMs }
      : null;
  }

  const endUnixMs = turn.settledAtUnixMs;
  if (
    !Number.isFinite(endUnixMs) ||
    (endUnixMs as number) < turn.startedAtUnixMs
  ) {
    return null;
  }

  return {
    kind: "settled",
    elapsedSeconds: Math.max(
      0,
      Math.floor(((endUnixMs as number) - turn.startedAtUnixMs) / 1_000)
    )
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
  isActiveTurn = false
): AgentTurnWorkSectionModel | null {
  const timing = resolveAgentTurnTiming(turn, isActiveTurn);
  if (!timing) {
    return null;
  }

  const leadingRowCount = countLeadingUserRows(group.rows);
  const leadingRows = group.rows.slice(0, leadingRowCount);
  const finalTarget = findFinalAssistantTextTarget(group.rows);
  const sections = buildOrderedSections(
    group.rows,
    leadingRowCount,
    finalTarget
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
  finalTarget: { rowIndex: number; messageIndex: number } | null
): AgentTurnWorkSectionSegment[] {
  const sections: AgentTurnWorkSectionSegment[] = [];
  for (let rowIndex = startIndex; rowIndex < rows.length; rowIndex += 1) {
    const entry = rows[rowIndex]!;
    if (entry.row.kind === "message" && entry.row.speaker === "assistant") {
      if (finalTarget?.rowIndex === rowIndex) {
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
