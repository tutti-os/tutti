import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import type {
  AgentToolGroupEntryVM,
  AgentToolGroupRowVM
} from "../contracts/agentToolGroupRowVM";
import type { AgentTurnSequenceItemVM } from "./agentTurnSequenceProjection";

const AVOID_GROUPING_EDITS = false;

export interface AgentComputedToolGroupVM {
  startIndex: number;
  endIndex: number;
  calls: AgentToolCallVM[];
  entries: AgentToolGroupEntryVM[];
}

export interface AgentComputedToolGroupInfoVM {
  groups: Map<number, AgentComputedToolGroupVM>;
  groupedIndices: Set<number>;
  suppressedIndices: Set<number>;
}

export function computeAgentToolGroups(
  sequence: readonly AgentTurnSequenceItemVM[],
  {
    avoidGroupingEdits = AVOID_GROUPING_EDITS
  }: {
    avoidGroupingEdits?: boolean;
  }
): AgentComputedToolGroupInfoVM {
  const groups = new Map<number, AgentComputedToolGroupVM>();
  const groupedIndices = new Set<number>();
  const suppressedIndices = new Set<number>();

  let currentCalls: AgentToolCallVM[] = [];
  let currentEntries: AgentToolGroupEntryVM[] = [];
  let currentIndices: number[] = [];
  let pendingBridgeEntries: AgentToolGroupEntryVM[] = [];
  let pendingBridgeIndices: number[] = [];
  let startIndex = -1;

  const finalizeGroup = () => {
    if (
      currentCalls.length >= 1 &&
      startIndex >= 0 &&
      currentIndices.length > 0
    ) {
      const endIndex = currentIndices[currentIndices.length - 1] ?? startIndex;
      groups.set(startIndex, {
        startIndex,
        endIndex,
        calls: [...currentCalls],
        entries: [...currentEntries]
      });
      currentIndices.forEach((index) => groupedIndices.add(index));
    }
    currentCalls = [];
    currentEntries = [];
    currentIndices = [];
    pendingBridgeEntries = [];
    pendingBridgeIndices = [];
    startIndex = -1;
  };

  for (let index = 0; index < sequence.length; index += 1) {
    const item = sequence[index];
    if (!item) {
      continue;
    }
    if (item.kind === "tool-call" && isGroupableToolCall(item.call)) {
      if (avoidGroupingEdits && isEditBoundaryToolCall(item.call)) {
        finalizeGroup();
        continue;
      }
      if (startIndex < 0) {
        startIndex = index;
      }
      if (pendingBridgeEntries.length > 0) {
        currentEntries.push(...pendingBridgeEntries);
        currentIndices.push(...pendingBridgeIndices);
        pendingBridgeEntries = [];
        pendingBridgeIndices = [];
      }
      currentCalls.push(item.call);
      currentEntries.push({ kind: "tool-call", call: item.call });
      currentIndices.push(index);
      continue;
    }

    if (
      item.kind === "thinking" &&
      startIndex >= 0 &&
      currentCalls.length > 0
    ) {
      pendingBridgeEntries.push({ kind: "thinking", thinking: item.thinking });
      pendingBridgeIndices.push(index);
      continue;
    }

    finalizeGroup();
  }

  finalizeGroup();

  return {
    groups,
    groupedIndices,
    suppressedIndices
  };
}

export function projectAgentToolGroupRowFromGroup(
  turnId: string,
  group: AgentComputedToolGroupVM,
  agentSessionId?: string
): AgentToolGroupRowVM {
  const firstCallId = group.calls[0]?.id ?? "unknown";
  return {
    kind: "tool-group",
    id: `tool-group:${turnId}:${group.calls.map((call) => call.id).join("+")}`,
    expansionKey: ["tool-group", agentSessionId, turnId, firstCallId]
      .filter(Boolean)
      .join(":"),
    turnId,
    grouped: true,
    calls: group.calls,
    summary: summarizeToolCallGroup(group.calls),
    entries: group.entries,
    occurredAtUnixMs:
      group.calls
        .map((call) => call.occurredAtUnixMs ?? 0)
        .reduce((latest, value) => (value > latest ? value : latest), 0) || null
  };
}

export function projectAgentSingleToolRow(
  call: AgentToolCallVM,
  turnId = call.turnId
): AgentToolGroupRowVM {
  return {
    kind: "tool-group",
    id: `tool-row:${call.id}`,
    expansionKey: `tool-group:${turnId}:${call.id}`,
    turnId,
    grouped: false,
    calls: [call],
    summary: null,
    entries: [{ kind: "tool-call", call }],
    occurredAtUnixMs: call.occurredAtUnixMs
  };
}

function isGroupableToolCall(call: AgentToolCallVM): boolean {
  switch (call.rendererKind) {
    case "approval":
    case "ask-user":
    case "plan-enter":
    case "plan-exit":
    case "task":
      return false;
    default:
      return true;
  }
}

function isEditBoundaryToolCall(call: AgentToolCallVM): boolean {
  return call.rendererKind === "edit" || call.rendererKind === "write";
}

function summarizeToolCallGroup(
  calls: readonly AgentToolCallVM[]
): string | null {
  if (calls.length < 2) {
    return null;
  }
  const changedTargets = dedupeStrings(
    calls
      .filter(
        (call) => call.rendererKind === "edit" || call.rendererKind === "write"
      )
      .map((call) => summarizeCallTarget(call.compactSummary ?? call.summary))
      .filter((value): value is string => value !== null)
  );
  if (changedTargets.length === 0) {
    return null;
  }
  if (changedTargets.length === 1) {
    return `Changed ${changedTargets[0]}`;
  }
  return `Changed ${changedTargets[0]} and ${changedTargets.length - 1} more files`;
}

function summarizeCallTarget(summary: string): string | null {
  const normalized = summary.trim();
  if (!normalized) {
    return null;
  }
  const firstLine = normalized.split("\n")[0]?.trim() ?? normalized;
  if (!firstLine) {
    return null;
  }
  const segments = firstLine.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? firstLine;
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
