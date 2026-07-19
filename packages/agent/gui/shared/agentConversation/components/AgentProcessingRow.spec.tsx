import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProcessingRowVM } from "../contracts/agentProcessingRowVM";
import { AgentProcessingRow } from "./AgentProcessingRow";

vi.mock("../../../i18n/index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../i18n/index")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        const minutes = Number(options?.minutes ?? 0);
        const seconds = Number(options?.seconds ?? 0);
        switch (key) {
          case "agentHost.agentGui.turnDurationShortSeconds":
            return `${seconds}s`;
          case "agentHost.agentGui.turnDurationShortMinutes":
            return `${minutes}m`;
          case "agentHost.agentGui.turnDurationShortMinutesSeconds":
            return `${minutes}m ${seconds}s`;
          default:
            return key;
        }
      }
    })
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentProcessingRow", () => {
  it("renders the awaiting label with the phase elapsed time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);

    render(
      <AgentProcessingRow
        row={processingRow({
          modelPhase: "awaiting",
          phaseStartedAtUnixMs: 8_000
        })}
        awaitingLabel="Waiting for response"
        streamingLabel="Responding"
      />
    );

    expect(screen.getByText("Waiting for response")).toBeTruthy();
    expect(screen.getByText("12s")).toBeTruthy();
  });

  it("renders the streaming label while the turn streams", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);

    render(
      <AgentProcessingRow
        row={processingRow({
          modelPhase: "streaming",
          phaseStartedAtUnixMs: 18_000
        })}
        awaitingLabel="Waiting for response"
        streamingLabel="Responding"
      />
    );

    expect(screen.getByText("Responding")).toBeTruthy();
    expect(screen.getByText("2s")).toBeTruthy();
    expect(screen.queryByText("Waiting for response")).toBeNull();
  });

  it("prefers a custom row label over the phase labels", () => {
    render(
      <AgentProcessingRow
        row={processingRow({ label: "Compacting context" })}
        awaitingLabel="Waiting for response"
        streamingLabel="Responding"
      />
    );

    expect(screen.getByText("Compacting context")).toBeTruthy();
    expect(screen.queryByText("Waiting for response")).toBeNull();
  });

  it("renders cumulative turn tokens with compact formatting", () => {
    render(
      <AgentProcessingRow
        row={processingRow({
          tokenUsage: { inputTokens: 12_345, outputTokens: 300 }
        })}
        awaitingLabel="Waiting for response"
        streamingLabel="Responding"
      />
    );

    expect(screen.getByText("↑ 12.3k")).toBeTruthy();
    expect(screen.getByText("↓ 300")).toBeTruthy();
  });

  it("keeps small token counts unabbreviated", () => {
    render(
      <AgentProcessingRow
        row={processingRow({
          tokenUsage: { inputTokens: 999, outputTokens: 1_000 }
        })}
        awaitingLabel="Waiting for response"
        streamingLabel="Responding"
      />
    );

    expect(screen.getByText("↑ 999")).toBeTruthy();
    expect(screen.getByText("↓ 1k")).toBeTruthy();
  });

  it("hides the token block when the turn carries no token usage", () => {
    const { container } = render(
      <AgentProcessingRow
        row={processingRow({ tokenUsage: null })}
        awaitingLabel="Waiting for response"
        streamingLabel="Responding"
      />
    );

    expect(
      container.querySelector(
        ".workspace-agents-status-panel__detail-processing-tokens"
      )
    ).toBeNull();
  });

  it("hides the timer when the row carries no phase start", () => {
    const { container } = render(
      <AgentProcessingRow
        row={processingRow({ phaseStartedAtUnixMs: null })}
        awaitingLabel="Waiting for response"
        streamingLabel="Responding"
      />
    );

    expect(
      container.querySelector(
        ".workspace-agents-status-panel__detail-processing-elapsed"
      )
    ).toBeNull();
  });
});

function processingRow(
  overrides: Partial<AgentProcessingRowVM> = {}
): AgentProcessingRowVM {
  return {
    kind: "processing",
    id: "processing:turn-1",
    turnId: "turn-1",
    occurredAtUnixMs: null,
    modelPhase: "awaiting",
    phaseStartedAtUnixMs: null,
    tokenUsage: null,
    ...overrides
  };
}
