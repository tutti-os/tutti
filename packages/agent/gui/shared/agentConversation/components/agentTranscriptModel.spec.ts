import { describe, expect, it } from "vitest";
import type { AgentTranscriptPresentationKind } from "../contracts/agentTranscriptPresentation";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";
import {
  buildAgentTranscriptTurnGroups,
  findTurnDividerRowIndexes,
  transcriptRowKey
} from "./agentTranscriptModel";

describe("buildAgentTranscriptTurnGroups", () => {
  it("keeps a turnless Goal control inside one surrounding Turn presentation group", () => {
    const rows = [row("turn-1"), goalControlRow(), row("turn-1")];
    const groups = buildAgentTranscriptTurnGroups(
      rows,
      rows.map(transcriptRowKey)
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("turn-1");
    expect(groups[0]?.turnId).toBe("turn-1");
    expect(groups[0]?.rows.map(({ row: item }) => item.kind)).toEqual([
      "message",
      "goal-control",
      "message"
    ]);
    expect(groups[0]?.rows[1]?.row.turnId).toBeNull();
  });

  it("keeps a Goal control between different Turns independent", () => {
    const rows = [row("turn-1"), goalControlRow(), row("turn-2")];
    const groups = buildAgentTranscriptTurnGroups(
      rows,
      rows.map(transcriptRowKey)
    );

    expect(groups.map((group) => group.key)).toEqual([
      "turn-1",
      "orphan:goal-control:clear",
      "turn-2"
    ]);
    expect(groups[1]?.turnId).toBeNull();
  });
});

describe("findTurnDividerRowIndexes", () => {
  const turnIndexes = new Map([
    ["turn-1", 0],
    ["turn-2", 1]
  ]);

  it("keeps the normal divider between turns", () => {
    expect([
      ...findTurnDividerRowIndexes(turnIndexes, [row("turn-1"), row("turn-2")])
    ]).toEqual([1]);
  });

  it("does not stack a turn divider immediately after a semantic boundary", () => {
    expect([
      ...findTurnDividerRowIndexes(turnIndexes, [
        row("turn-1", "turn-boundary"),
        row("turn-2")
      ])
    ]).toEqual([]);
  });

  it("keeps the divider for running progress and non-adjacent boundaries", () => {
    expect([
      ...findTurnDividerRowIndexes(turnIndexes, [
        row("turn-1", "specific-progress"),
        row("turn-2")
      ])
    ]).toEqual([1]);
    expect([
      ...findTurnDividerRowIndexes(turnIndexes, [
        row("turn-1", "turn-boundary"),
        row("turn-1"),
        row("turn-2")
      ])
    ]).toEqual([2]);
  });
});

function row(
  turnId: string,
  presentationKind: AgentTranscriptPresentationKind = "content"
): AgentTranscriptRowVM {
  return {
    kind: "message",
    id: `row:${turnId}:${presentationKind}`,
    turnId,
    speaker: "assistant",
    messages: [
      {
        kind: "message-content",
        id: `message:${turnId}:${presentationKind}`,
        turnId,
        body: presentationKind,
        presentationKind,
        occurredAtUnixMs: 1
      }
    ],
    thinking: [],
    occurredAtUnixMs: 1
  };
}

function goalControlRow(): AgentTranscriptRowVM {
  return {
    kind: "goal-control",
    id: "goal-control:clear",
    turnId: null,
    action: "clear",
    body: "/goal clear",
    occurredAtUnixMs: 2
  };
}
