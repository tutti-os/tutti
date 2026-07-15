import type {
  AgentMessageContentVM,
  AgentThinkingContentVM
} from "../contracts/agentMessageRowVM";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";
import type { AgentComputedToolGroupVM } from "./agentToolGroupingProjection";
import type { AgentTurnSequenceItemVM } from "./agentTurnSequenceProjection";
import {
  projectAgentSingleToolRow,
  projectAgentToolGroupRowFromGroup
} from "./agentToolGroupingProjection";
import { chunkBy } from "./chunkBy";

/**
 * A render unit is one item that will become (part of) a single transcript
 * row. Unlike the raw turn sequence, tool groups have already been resolved to
 * one unit spanning their calls, and grouped/suppressed indices have been
 * dropped. This flattening is what lets the row pass reason about immediate
 * neighbours instead of looking ahead across skipped indices.
 */
export type AgentRenderUnit =
  | { tag: "tool-group"; group: AgentComputedToolGroupVM }
  | { tag: "tool"; call: AgentToolCallVM }
  | {
      tag: "user-message";
      row: Extract<AgentTranscriptRowVM, { kind: "message" }>;
    }
  | { tag: "thinking"; thinking: AgentThinkingContentVM }
  | { tag: "message"; message: AgentMessageContentVM };

export type AgentRenderUnitTag = AgentRenderUnit["tag"];

/** Pure classifier for a raw turn sequence item. */
export function tagOf(
  item: AgentTurnSequenceItemVM
): "user-message" | "message" | "thinking" | "tool" {
  switch (item.kind) {
    case "user-message":
      return "user-message";
    case "assistant-message":
      return "message";
    case "thinking":
      return "thinking";
    case "tool-call":
      return "tool";
  }
}

/**
 * Run predicate: a thinking unit is absorbed into the assistant message that
 * immediately follows it (rendered as that message's `thinking`). Every other
 * adjacency starts a new run, so tools, tool groups and lone thinking each
 * become their own row.
 */
export function thinkingAbsorbedByMessage(
  previous: AgentRenderUnit,
  current: AgentRenderUnit
): boolean {
  return previous.tag === "thinking" && current.tag === "message";
}

/**
 * Resolve the raw turn sequence into render units: emit one unit per tool
 * group (skipping its span), drop grouped/suppressed indices, and tag the
 * remaining message/thinking/tool items. Removing skipped items here is what
 * makes a thinking and a later message become adjacent units when only
 * suppressed tools sat between them.
 */
export function toRenderUnits(
  sequence: readonly AgentTurnSequenceItemVM[],
  groups: ReadonlyMap<number, AgentComputedToolGroupVM>,
  skippedIndices: ReadonlySet<number>
): AgentRenderUnit[] {
  const units: AgentRenderUnit[] = [];
  for (let index = 0; index < sequence.length; index += 1) {
    const group = groups.get(index);
    if (group) {
      units.push({ tag: "tool-group", group });
      index = group.endIndex;
      continue;
    }
    if (skippedIndices.has(index)) {
      continue;
    }
    const item = sequence[index];
    if (!item) {
      continue;
    }
    switch (item.kind) {
      case "user-message":
        units.push({ tag: "user-message", row: item.row });
        break;
      case "assistant-message":
        units.push({ tag: "message", message: item.message });
        break;
      case "thinking":
        units.push({ tag: "thinking", thinking: item.thinking });
        break;
      case "tool-call":
        units.push({ tag: "tool", call: item.call });
        break;
    }
  }
  return units;
}

/**
 * Render one run into a transcript row. A run is either a singleton
 * (tool group / tool / lone thinking) or leading thinking units followed by a
 * single assistant message that absorbs them.
 */
export function renderRun(
  run: readonly AgentRenderUnit[],
  turnId: string,
  agentSessionId?: string
): AgentTranscriptRowVM {
  const last = run.at(-1);
  if (!last) {
    throw new Error("renderRun received an empty run");
  }
  if (last.tag === "tool-group") {
    return projectAgentToolGroupRowFromGroup(
      turnId,
      last.group,
      agentSessionId
    );
  }
  if (last.tag === "tool") {
    return projectAgentSingleToolRow(last.call, turnId);
  }
  if (last.tag === "user-message") {
    return last.row;
  }
  const thinking = run
    .filter(
      (unit): unit is Extract<AgentRenderUnit, { tag: "thinking" }> =>
        unit.tag === "thinking"
    )
    .map((unit) => unit.thinking);
  if (last.tag === "message") {
    return {
      kind: "message",
      id: `message:assistant:${last.message.id}`,
      turnId: last.message.turnId,
      speaker: "assistant",
      messages: [last.message],
      thinking,
      occurredAtUnixMs: last.message.occurredAtUnixMs
    };
  }
  return {
    kind: "message",
    id: `message:thinking:${turnId}:${thinking.map((entry) => entry.id).join("+")}`,
    turnId,
    speaker: "assistant",
    messages: [],
    thinking,
    occurredAtUnixMs:
      thinking.at(-1)?.occurredAtUnixMs ?? thinking[0]?.occurredAtUnixMs ?? null
  };
}

/** Project a turn's sequence (with computed groups/skips) into transcript rows. */
export function projectTurnRows(
  sequence: readonly AgentTurnSequenceItemVM[],
  groups: ReadonlyMap<number, AgentComputedToolGroupVM>,
  skippedIndices: ReadonlySet<number>,
  turnId: string,
  agentSessionId?: string
): AgentTranscriptRowVM[] {
  const units = toRenderUnits(sequence, groups, skippedIndices);
  return chunkBy(units, thinkingAbsorbedByMessage).map((run) =>
    renderRun(run, turnId, agentSessionId)
  );
}
