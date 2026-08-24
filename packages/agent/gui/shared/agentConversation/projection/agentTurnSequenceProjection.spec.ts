import { describe, expect, it } from "vitest";
import type { WorkspaceAgentActivityTimelineItem } from "../../workspaceAgentTimelineTypes";
import type { WorkspaceAgentSessionDetailTurn } from "../../workspaceAgentSessionDetailViewModel";
import { buildAgentTurnSequenceItems } from "./agentTurnSequenceProjection";

function timelineItem(
  id: number,
  seq: number,
  occurredAtUnixMs: number
): WorkspaceAgentActivityTimelineItem {
  return {
    id,
    actorId: "agent",
    actorType: "agent",
    agentSessionId: "session-1",
    eventId: `event-${id}`,
    itemType: "event",
    seq,
    occurredAtUnixMs
  };
}

function makeTurn(): WorkspaceAgentSessionDetailTurn {
  return {
    id: "turn-1",
    userMessage: null,
    userMessages: [],
    agentMessages: [],
    toolCalls: [],
    toolCallCount: 1,
    hasFailedToolCall: false,
    agentItems: [
      {
        kind: "message",
        message: {
          id: "assistant-1",
          body: "assistant reply",
          occurredAtUnixMs: 200,
          sourceTimelineItems: [timelineItem(2, 2, 200)]
        }
      },
      {
        kind: "tool-calls",
        id: "tool-group",
        toolCallCount: 1,
        hasFailedToolCall: false,
        toolCalls: [
          {
            id: "tool-1",
            name: "Bash",
            toolName: "bash",
            callType: "tool",
            status: "completed",
            statusKind: "completed",
            summary: "",
            payload: null,
            occurredAtUnixMs: 100,
            sourceTimelineItems: [timelineItem(1, 1, 100)]
          }
        ]
      },
      {
        kind: "thinking",
        thinking: {
          id: "thinking-1",
          body: "thinking"
        }
      }
    ]
  };
}

describe("buildAgentTurnSequenceItems", () => {
  it("uses known pairwise positions when another row has no position", () => {
    const sequence = buildAgentTurnSequenceItems(makeTurn());

    expect(sequence.map((item) => item.kind)).toEqual([
      "tool-call",
      "assistant-message",
      "thinking"
    ]);
    expect(sequence[0]?.kind === "tool-call" && sequence[0].call.id).toBe(
      "tool-1"
    );
  });

  it("keeps a transitive order when sequence and timestamp metadata are mixed", () => {
    const sequence = buildAgentTurnSequenceItems({
      ...makeTurn(),
      agentItems: [
        toolGroup("seq-1", 1, 300),
        toolGroup("timestamp-only", 0, 200),
        toolGroup("seq-2", 2, 100)
      ]
    });

    expect(
      sequence.map((item) =>
        item.kind === "tool-call" ? item.call.id : "unexpected"
      )
    ).toEqual(["seq-1", "seq-2", "timestamp-only"]);
  });
});

function toolGroup(id: string, seq: number, occurredAtUnixMs: number) {
  return {
    kind: "tool-calls" as const,
    id: `group-${id}`,
    toolCallCount: 1,
    hasFailedToolCall: false,
    toolCalls: [
      {
        id,
        name: "Bash",
        toolName: "bash",
        callType: "tool" as const,
        status: "completed" as const,
        statusKind: "completed" as const,
        summary: "",
        payload: null,
        occurredAtUnixMs,
        sourceTimelineItems: [timelineItem(id.length, seq, occurredAtUnixMs)]
      }
    ]
  };
}
