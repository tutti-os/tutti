import { describe, expect, it } from "vitest";
import type { AgentMessageRowVM } from "../contracts/agentMessageRowVM";
import { resolveAgentTranscriptEditRetryRowId } from "./useAgentTranscriptEditRetryProjection";

describe("resolveAgentTranscriptEditRetryRowId", () => {
  it("selects only the exact eligible user turn with a lossless text block", () => {
    const older = userRow("row-old", "turn-old", "old");
    const latest = userRow("row-latest", "turn-latest", "latest");
    expect(
      resolveAgentTranscriptEditRetryRowId([older, latest], "turn-latest")
    ).toBe("row-latest");
    expect(
      resolveAgentTranscriptEditRetryRowId(
        [older, { ...latest, rawFirstTextBlock: null }],
        "turn-latest"
      )
    ).toBeNull();
    expect(
      resolveAgentTranscriptEditRetryRowId([older, latest], "turn-missing")
    ).toBeNull();
  });
});

function userRow(
  id: string,
  turnId: string,
  rawFirstTextBlock: string
): AgentMessageRowVM {
  return {
    kind: "message",
    id,
    turnId,
    speaker: "user",
    rawFirstTextBlock,
    messages: [],
    thinking: [],
    occurredAtUnixMs: 1
  };
}
