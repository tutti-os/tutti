// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  AgentProcessingRow,
  effectivePhase,
  type AgentProcessingLabels
} from "./AgentProcessingRow";

const processingLabels: AgentProcessingLabels = {
  phases: {
    preparing: "Preparing",
    submitting: "Submitting",
    waiting_response: "Waiting for response",
    thinking: "Thinking",
    generating: "Generating response",
    using_tool: "Using a tool",
    waiting_tool: "Waiting for tool result",
    reconnecting: "Reconnecting",
    waiting_continuation: "Waiting for more response"
  },
  elapsedSeconds: (seconds) => `${seconds}s`
};

describe("AgentProcessingRow", () => {
  it("keeps the phase label without repeating the turn elapsed time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(63_000);

    try {
      render(
        createElement(AgentProcessingRow, {
          row: {
            kind: "processing",
            id: "processing-1",
            turnId: "turn-1",
            phase: "waiting_response",
            startedAtUnixMs: 0,
            lastProgressAtUnixMs: 63_000,
            occurredAtUnixMs: 0
          },
          label: "Processing",
          statusLabels: processingLabels
        })
      );

      const statusText = screen.getByRole("status").textContent;
      expect(statusText).toContain("Waiting for response");
      expect(statusText).not.toContain("63s");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("effectivePhase", () => {
  it("falls back from a stalled submit to waiting for response", () => {
    expect(effectivePhase("submitting", 3, null)).toBe("waiting_response");
  });

  it("falls back from stalled model and tool progress without guessing", () => {
    expect(effectivePhase("thinking", 9, 3)).toBe("waiting_continuation");
    expect(effectivePhase("generating", 9, 3)).toBe("waiting_continuation");
    expect(effectivePhase("using_tool", 9, 3)).toBe("waiting_tool");
  });

  it("keeps reconnecting authoritative", () => {
    expect(effectivePhase("reconnecting", 30, 30)).toBe("reconnecting");
  });
});
