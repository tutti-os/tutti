import type {
  WorkspaceAgentSessionDetailMessage,
  WorkspaceAgentSessionDetailThinking,
  WorkspaceAgentSessionDetailTurn
} from "../../workspaceAgentSessionDetailViewModel";
import type {
  AgentMessageContentVM,
  AgentThinkingContentVM
} from "../contracts/agentMessageRowVM";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import type {
  AgentToolGroupEntryVM,
  AgentToolGroupRowVM
} from "../contracts/agentToolGroupRowVM";
import { projectAgentToolCall } from "./agentToolProjection";

const AVOID_GROUPING_EDITS = false;

export type AgentTurnSequenceItemVM =
  | {
      kind: "assistant-message";
      message: AgentMessageContentVM;
    }
  | {
      kind: "thinking";
      thinking: AgentThinkingContentVM;
    }
  | {
      kind: "tool-call";
      call: AgentToolCallVM;
    };

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

export function buildAgentTurnSequenceItems(
  turn: WorkspaceAgentSessionDetailTurn
): AgentTurnSequenceItemVM[] {
  const items = turn.rawAgentItems ?? turn.agentItems;
  const out: AgentTurnSequenceItemVM[] = [];
  items.forEach((item) => {
    if (item.kind === "message") {
      out.push({
        kind: "assistant-message",
        message: projectMessage(item.message, turn.id)
      });
      return;
    }
    if (item.kind === "thinking") {
      out.push({
        kind: "thinking",
        thinking: projectThinking(item.thinking, turn.id)
      });
      return;
    }
    const sourceEntries =
      item.groupEntries ??
      item.toolCalls.map((call) => ({ kind: "tool-call", call }) as const);
    sourceEntries.forEach((entry) => {
      if (entry.kind === "thinking") {
        out.push({
          kind: "thinking",
          thinking: projectThinking(entry.thinking, turn.id)
        });
        return;
      }
      out.push({
        kind: "tool-call",
        call: projectAgentToolCall(entry.call)
      });
    });
  });
  return out;
}

export function computeAgentToolGroups(
  sequence: readonly AgentTurnSequenceItemVM[],
  {
    allowTrailingFinalization,
    avoidGroupingEdits = AVOID_GROUPING_EDITS
  }: {
    allowTrailingFinalization: boolean;
    avoidGroupingEdits?: boolean;
  }
): AgentComputedToolGroupInfoVM {
  const groups = new Map<number, AgentComputedToolGroupVM>();
  const groupedIndices = new Set<number>();
  // Nothing is hidden anymore. While a session streams a burst of sequential
  // tool calls (e.g. Codex), the trailing run whose newest tool is still active
  // is rendered as individual, always-visible rows instead of grouping or
  // collapsing it. Grouping that run while the tail tool kept changing was what
  // made the transcript flicker between "one tool" and "many" as the burst
  // advanced. Items before the active trailing run still group as usual.
  const suppressedIndices = new Set<number>();
  const splitFromIndex = allowTrailingFinalization
    ? -1
    : findUnfinalizedTailRunStartIndex(sequence);

  let currentCalls: AgentToolCallVM[] = [];
  let currentEntries: AgentToolGroupEntryVM[] = [];
  let currentIndices: number[] = [];
  let pendingBridgeEntries: AgentToolGroupEntryVM[] = [];
  let pendingBridgeIndices: number[] = [];
  let startIndex = -1;

  const finalizeGroup = () => {
    if (
      currentCalls.length >= 2 &&
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
    // Once we reach the still-streaming trailing run, stop grouping: close any
    // open group and let every remaining item fall through to its own visible
    // row so the live view only ever appends.
    if (splitFromIndex >= 0 && index >= splitFromIndex) {
      finalizeGroup();
      continue;
    }
    if (item.kind === "tool-call" && isGroupableToolCall(item.call)) {
      if (avoidGroupingEdits && isEditBoundaryToolCall(item.call)) {
        finalizeGroup();
        startIndex = index;
        currentCalls = [item.call];
        currentEntries = [{ kind: "tool-call", call: item.call }];
        currentIndices = [index];
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

  if (allowTrailingFinalization) {
    finalizeGroup();
  }

  return {
    groups,
    groupedIndices,
    suppressedIndices
  };
}

export function projectAgentToolGroupRowFromGroup(
  turnId: string,
  group: AgentComputedToolGroupVM
): AgentToolGroupRowVM {
  const firstCallId = group.calls[0]?.id ?? "unknown";
  return {
    kind: "tool-group",
    id: `tool-group:${turnId}:${group.calls.map((call) => call.id).join("+")}`,
    expansionKey: `tool-group:${turnId}:${firstCallId}`,
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

function projectMessage(
  message: WorkspaceAgentSessionDetailMessage,
  turnId: string
): AgentMessageContentVM {
  const projected: AgentMessageContentVM = {
    kind: "message-content",
    id: message.id,
    turnId: message.turnId ?? turnId,
    body: message.body,
    statusKind: message.statusKind ?? null,
    occurredAtUnixMs: message.occurredAtUnixMs ?? null,
    visibleError: message.visibleError ?? null,
    systemNotice: message.systemNotice ?? null
  };
  if (message.sourceTimelineItems) {
    projected.sourceTimelineItems = message.sourceTimelineItems;
    // Codex plan-mode proposals arrive tagged by the daemon and render as a
    // dedicated plan card instead of a regular assistant bubble.
    if (
      message.sourceTimelineItems.some(
        (item) => item.payload?.messageKind === "plan"
      )
    ) {
      projected.contentKind = "plan";
    }
  }
  return projected;
}

function projectThinking(
  thinking: WorkspaceAgentSessionDetailThinking,
  turnId: string
): AgentThinkingContentVM {
  const projected: AgentThinkingContentVM = {
    kind: "thinking-content",
    id: thinking.id,
    turnId: thinking.turnId ?? turnId,
    body: thinking.body,
    statusKind: thinking.statusKind ?? null,
    occurredAtUnixMs: thinking.occurredAtUnixMs ?? null
  };
  if (thinking.sourceTimelineItems) {
    projected.sourceTimelineItems = thinking.sourceTimelineItems;
  }
  return projected;
}

function isGroupableToolCall(call: AgentToolCallVM): boolean {
  if (call.statusKind === "working" || call.statusKind === "waiting") {
    return false;
  }
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

/**
 * Index where the unfinalized turn's trailing tool chain begins, or -1 when
 * there is none. Completion of an individual tool does not finalize the turn:
 * while the canonical turn is still active, every tool since the last
 * assistant message remains individually visible. Thinking entries may bridge
 * those calls and must remain visible too.
 */
function findUnfinalizedTailRunStartIndex(
  sequence: readonly AgentTurnSequenceItemVM[]
): number {
  let startIndex = -1;
  let hasToolCall = false;
  for (let index = sequence.length - 1; index >= 0; index -= 1) {
    const item = sequence[index];
    if (!item) continue;
    if (item.kind === "assistant-message") break;
    if (item.kind === "tool-call") hasToolCall = true;
    startIndex = index;
  }
  return hasToolCall ? startIndex : -1;
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
