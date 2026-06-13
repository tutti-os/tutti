import { describe, expect, it } from "vitest";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";
import { assessAgentTranscriptComplexity } from "./agentTranscriptComplexity";

describe("assessAgentTranscriptComplexity", () => {
  it("does not virtualize normal short transcripts below the old turn threshold", () => {
    const assessment = assessAgentTranscriptComplexity(
      Array.from({ length: 12 }, (_, index) => ({
        rows: [{ row: messageRow(index, "Short update.") }]
      }))
    );

    expect(assessment.shouldVirtualize).toBe(false);
  });

  it("keeps the existing high turn-count trigger", () => {
    const assessment = assessAgentTranscriptComplexity(
      Array.from({ length: 30 }, (_, index) => ({
        rows: [{ row: messageRow(index, "Short update.") }]
      }))
    );

    expect(assessment.shouldVirtualize).toBe(true);
    expect(assessment.turnCount).toBe(30);
  });

  it("virtualizes a single complex turn before many turns accumulate", () => {
    const assessment = assessAgentTranscriptComplexity([
      {
        rows: [
          {
            row: messageRow(
              0,
              [
                "Complex turn intro.",
                longText(9000),
                "```ts",
                "const result = runLargeExample();",
                "```",
                "```json",
                '{"ok":true}',
                "```",
                "| File | Status |",
                "| --- | --- |",
                "| app.tsx | updated |",
                "![Preview](preview.png)"
              ].join("\n")
            )
          }
        ]
      }
    ]);

    expect(assessment.shouldVirtualize).toBe(true);
    expect(assessment.turnCount).toBe(1);
    expect(assessment.maxTurnScore).toBeGreaterThanOrEqual(24);
  });

  it("virtualizes accumulated moderate complexity before thirty turns", () => {
    const assessment = assessAgentTranscriptComplexity(
      Array.from({ length: 20 }, (_, index) => ({
        rows: [{ row: messageRow(index, longText(1200)) }]
      }))
    );

    expect(assessment.shouldVirtualize).toBe(true);
    expect(assessment.turnCount).toBe(20);
  });
});

function messageRow(index: number, body: string): AgentTranscriptRowVM {
  return {
    kind: "message",
    id: `row-${index}`,
    turnId: `turn-${index}`,
    speaker: "assistant",
    messages: [
      {
        kind: "message-content",
        id: `message-${index}`,
        turnId: `turn-${index}`,
        body,
        occurredAtUnixMs: index
      }
    ],
    thinking: [],
    occurredAtUnixMs: index
  };
}

function longText(length: number): string {
  return "x".repeat(length);
}
