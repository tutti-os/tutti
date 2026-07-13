import { useLayoutEffect, useRef } from "react";
import type { AgentConversationVM } from "../contracts/agentConversationVM";

export interface AgentTranscriptTurnGroup {
  key: string;
  turnId: string | null;
  rows: Array<{
    row: AgentConversationVM["rows"][number];
    rowIndex: number;
  }>;
}

export interface AgentMessageLocatorItem {
  hasAgentResponse: boolean;
  key: string;
  rowKey: string;
  turnGroupIndex: number;
  rowIndex: number;
  summary: string;
}

export function useEnteringTranscriptRows(
  rowKeys: string[]
): ReadonlySet<string> {
  const previousKeysRef = useRef<Set<string> | null>(null);
  const previousKeys = previousKeysRef.current;
  const enteringRowKeys = new Set<string>();

  if (previousKeys) {
    for (const key of rowKeys) {
      if (!previousKeys.has(key)) {
        enteringRowKeys.add(key);
      }
    }
  }

  useLayoutEffect(() => {
    previousKeysRef.current = new Set(rowKeys);
  }, [rowKeys]);

  return enteringRowKeys;
}

export function transcriptRowKey(
  row: AgentConversationVM["rows"][number]
): string {
  if (row.kind === "tool-group") {
    return row.expansionKey ?? row.id;
  }
  return row.id;
}

export function buildAgentTranscriptTurnGroups(
  rows: ReadonlyArray<AgentConversationVM["rows"][number]>,
  rowKeys: ReadonlyArray<string>
): AgentTranscriptTurnGroup[] {
  const groups: AgentTranscriptTurnGroup[] = [];
  let currentGroup: AgentTranscriptTurnGroup | null = null;

  rows.forEach((row, rowIndex) => {
    const turnId = row.turnId ?? null;
    if (!currentGroup || currentGroup.turnId !== turnId) {
      currentGroup = {
        key: turnId ?? `orphan:${rowKeys[rowIndex] ?? transcriptRowKey(row)}`,
        turnId,
        rows: []
      };
      groups.push(currentGroup);
    }

    currentGroup.rows.push({ row, rowIndex });
  });

  return groups;
}

export function buildTurnGroupIndexByRowIndex(
  turnGroups: readonly AgentTranscriptTurnGroup[]
): ReadonlyMap<number, number> {
  const rowIndexToTurnGroupIndex = new Map<number, number>();
  turnGroups.forEach((group, groupIndex) => {
    group.rows.forEach(({ rowIndex }) => {
      rowIndexToTurnGroupIndex.set(rowIndex, groupIndex);
    });
  });
  return rowIndexToTurnGroupIndex;
}

export function buildUserMessageLocatorItems(
  rows: ReadonlyArray<AgentConversationVM["rows"][number]>,
  rowKeys: ReadonlyArray<string>,
  turnGroupIndexByRowIndex: ReadonlyMap<number, number>
): AgentMessageLocatorItem[] {
  const items: AgentMessageLocatorItem[] = [];
  rows.forEach((row, rowIndex) => {
    if (row.kind !== "message" || row.speaker !== "user") {
      return;
    }
    const summary = summarizeUserMessageRow(row);
    if (!summary) {
      return;
    }
    const rowKey = rowKeys[rowIndex] ?? transcriptRowKey(row);
    items.push({
      hasAgentResponse: hasAgentResponseForTurn(rows, row, rowIndex),
      key: `user-message:${rowKey}`,
      rowKey,
      turnGroupIndex: turnGroupIndexByRowIndex.get(rowIndex) ?? rowIndex,
      rowIndex,
      summary
    });
  });
  return items;
}

export function hasAgentResponseForTurn(
  rows: ReadonlyArray<AgentConversationVM["rows"][number]>,
  userRow: AgentConversationVM["rows"][number],
  userRowIndex: number
): boolean {
  const turnId = userRow.turnId ?? null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.kind !== "message") {
      continue;
    }
    if (row.speaker === "user") {
      return false;
    }
    if (turnId && row.turnId !== turnId) {
      return false;
    }
    if (row.speaker === "assistant") {
      return true;
    }
  }
  return false;
}

export function summarizeUserMessageRow(
  row: Extract<AgentConversationVM["rows"][number], { kind: "message" }>
): string {
  return normalizeLocatorSummary(
    row.messages.map((message) => message.copyText ?? message.body).join(" ")
  );
}

export function normalizeLocatorSummary(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function escapeCssString(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

export function findTurnDividerRowIndexes(
  turnIndexById: ReadonlyMap<string, number>,
  rows: ReadonlyArray<AgentConversationVM["rows"][number]>
): ReadonlySet<number> {
  const dividerRowIndexes = new Set<number>();
  const previousTurnIds = new Set<string>();

  rows.forEach((row, rowIndex) => {
    const currentTurnId = row.turnId ?? null;
    if (!currentTurnId) {
      return;
    }

    const turnIndex = turnIndexById.get(currentTurnId) ?? -1;
    const previousTurnId = rows[rowIndex - 1]?.turnId ?? null;
    if (
      rowIndex > 0 &&
      turnIndex > 0 &&
      previousTurnId &&
      previousTurnId !== currentTurnId &&
      !previousTurnIds.has(currentTurnId)
    ) {
      dividerRowIndexes.add(rowIndex);
    }

    previousTurnIds.add(currentTurnId);
  });

  return dividerRowIndexes;
}
