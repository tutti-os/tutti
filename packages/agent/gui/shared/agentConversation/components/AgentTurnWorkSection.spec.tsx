import { act, fireEvent, render, screen } from "@testing-library/react";
import type { AgentActivityTurn } from "@tutti-os/agent-activity-core";
import type { JSX } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";
import type { AgentTranscriptTurnGroup } from "./agentTranscriptModel";
import { AgentTurnWorkSection as AgentTurnWorkSectionView } from "./AgentTurnWorkSection";
import type { AgentTurnDisclosureStore } from "./AgentTurnDisclosureContext";
import { buildAgentTurnWorkSectionModel } from "./agentTurnWorkSectionModel";

vi.mock("../../../i18n/index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../i18n/index")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) =>
        key === "agentHost.agentGui.turnProcessedSeconds"
          ? `Processed for ${String(options?.seconds)}s`
          : key === "agentHost.agentGui.turnDurationSeconds"
            ? `${String(options?.seconds)}s`
            : key.startsWith("agentHost.agentGui.turnStage") &&
                key !== "agentHost.agentGui.turnStageBreakdown"
              ? `${key} ${String(options?.duration)}`
              : key
    })
  };
});

const disclosureStore: AgentTurnDisclosureStore = {
  expandedOverrides: {},
  setExpandedOverride: () => {}
};

describe("AgentTurnWorkSection", () => {
  it("ticks only the duration label without rerendering transcript rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const renderRow = vi.fn((row: AgentTranscriptRowVM, rowIndex: number) => (
      <div key={`${row.id}:${rowIndex}`}>{row.id}</div>
    ));

    try {
      render(
        <AgentTurnWorkSection
          group={turnGroup()}
          sessionId="session-1"
          turn={canonicalTurn()}
          isActiveTurn
          disclosureStore={disclosureStore}
          renderRow={renderRow}
        />
      );

      expect(screen.getByText("Processed for 45s")).toBeTruthy();
      expect(vi.getTimerCount()).toBe(1);
      renderRow.mockClear();
      act(() => vi.advanceTimersByTime(5_000));
      expect(screen.getByText("Processed for 50s")).toBeTruthy();
      expect(renderRow).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows and ticks wall-clock time while the active turn is waiting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);

    try {
      render(
        <AgentTurnWorkSection
          group={turnGroup()}
          sessionId="session-1"
          turn={canonicalTurn({ phase: "waiting" })}
          isActiveTurn
          disclosureStore={disclosureStore}
          renderRow={(row, rowIndex) => (
            <div key={`${row.id}:${rowIndex}`}>{row.id}</div>
          )}
        />
      );

      expect(screen.getByText("Processed for 45s")).toBeTruthy();
      expect(vi.getTimerCount()).toBe(1);
      act(() => vi.advanceTimersByTime(5_000));
      expect(screen.getByText("Processed for 50s")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the live timer when a running turn transitions to waiting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const renderRow = (row: AgentTranscriptRowVM, rowIndex: number) => (
      <div key={`${row.id}:${rowIndex}`}>{row.id}</div>
    );

    try {
      const { rerender } = render(
        <AgentTurnWorkSection
          group={turnGroup()}
          sessionId="session-1"
          turn={canonicalTurn({ phase: "running" })}
          isActiveTurn
          disclosureStore={disclosureStore}
          renderRow={renderRow}
        />
      );
      expect(screen.getByText("Processed for 45s")).toBeTruthy();
      expect(vi.getTimerCount()).toBe(1);

      rerender(
        <AgentTurnWorkSection
          group={turnGroup()}
          sessionId="session-1"
          turn={canonicalTurn({ phase: "waiting" })}
          isActiveTurn
          disclosureStore={disclosureStore}
          renderRow={renderRow}
        />
      );

      expect(screen.getByText("Processed for 45s")).toBeTruthy();
      expect(vi.getTimerCount()).toBe(1);
      act(() => vi.advanceTimersByTime(5_000));
      expect(screen.getByText("Processed for 50s")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the live timer and freezes timing when the turn settles", () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const renderRow = (row: AgentTranscriptRowVM, rowIndex: number) => (
      <div key={`${row.id}:${rowIndex}`}>{row.id}</div>
    );

    try {
      const { rerender } = render(
        <AgentTurnWorkSection
          group={turnGroup()}
          sessionId="session-1"
          turn={canonicalTurn()}
          isActiveTurn
          disclosureStore={disclosureStore}
          renderRow={renderRow}
        />
      );
      expect(vi.getTimerCount()).toBe(1);

      rerender(
        <AgentTurnWorkSection
          group={turnGroup()}
          sessionId="session-1"
          turn={canonicalTurn({
            phase: "settled",
            outcome: "completed",
            settledAtUnixMs: 12_000
          })}
          isActiveTurn={false}
          disclosureStore={disclosureStore}
          renderRow={renderRow}
        />
      );

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders interleaved turn rows in their original chronology", () => {
    const expandedStore: AgentTurnDisclosureStore = {
      expandedOverrides: { "session-1:turn-1": true },
      setExpandedOverride: () => {}
    };
    const { container } = render(
      <AgentTurnWorkSection
        group={interleavedTurnGroup()}
        sessionId="session-1"
        turn={canonicalTurn({
          phase: "settled",
          outcome: "completed",
          settledAtUnixMs: 15_000
        })}
        isActiveTurn={false}
        disclosureStore={expandedStore}
        renderRow={(row) => (
          <div key={row.id} data-test-row-id={row.id}>
            {row.kind === "message" ? row.messages[0]?.body : row.id}
          </div>
        )}
      />
    );

    expect(
      [...container.querySelectorAll("[data-test-row-id]")].map(
        (element) => element.textContent
      )
    ).toEqual([
      "First request",
      "Earlier answer",
      "Follow-up",
      "tools",
      "Final answer"
    ]);
  });

  it("collapses ordinary assistant replies while keeping follow-up guidance visible", () => {
    render(
      <AgentTurnWorkSection
        group={interleavedTurnGroup()}
        sessionId="session-1"
        turn={canonicalTurn({
          phase: "settled",
          outcome: "completed",
          settledAtUnixMs: 15_000
        })}
        isActiveTurn={false}
        disclosureStore={disclosureStore}
        renderRow={(row) => (
          <div key={row.id} data-test-row-id={row.id}>
            {row.kind === "message" ? row.messages[0]?.body : row.id}
          </div>
        )}
      />
    );

    expect(screen.queryByText("Earlier answer")).toBeNull();
    expect(screen.getByText("Follow-up")).toBeTruthy();
    expect(screen.getByText("Final answer")).toBeTruthy();
    expect(screen.queryByText("tools")).toBeNull();
  });

  it("makes the duration text part of the turn disclosure button", () => {
    const setExpandedOverride = vi.fn();
    render(
      <AgentTurnWorkSection
        group={interleavedTurnGroup()}
        sessionId="session-1"
        turn={canonicalTurn({
          phase: "settled",
          outcome: "completed",
          settledAtUnixMs: 15_000
        })}
        isActiveTurn={false}
        disclosureStore={{
          expandedOverrides: {},
          setExpandedOverride
        }}
        renderRow={(row) => <div key={row.id}>{row.id}</div>}
      />
    );

    const duration = screen.getByText("agentHost.agentGui.turnTotalSeconds");
    const toggle = screen.getByRole("button", {
      name: "agentHost.agentGui.expandTurnWork"
    });
    expect(toggle).toContainElement(duration);

    fireEvent.click(duration);

    expect(setExpandedOverride).toHaveBeenCalledWith("session-1:turn-1", true);
  });

  it("shows the stage breakdown when task details are expanded", () => {
    render(
      <AgentTurnWorkSection
        group={interleavedTurnGroup()}
        sessionId="session-1"
        turn={canonicalTurn({
          phase: "settled",
          outcome: "completed",
          settledAtUnixMs: 15_000
        })}
        isActiveTurn={false}
        disclosureStore={{
          expandedOverrides: { "session-1:turn-1": true },
          setExpandedOverride: () => {}
        }}
        renderRow={(row) => <div key={row.id}>{row.id}</div>}
      />
    );

    const breakdown = screen.getByLabelText(
      /agentHost\.agentGui\.turnStageBreakdown/
    );
    expect(breakdown.textContent).toContain(
      "agentHost.agentGui.turnStageStartup"
    );
    expect(breakdown.textContent).toContain(
      "agentHost.agentGui.turnStageFirstResponse"
    );
    expect(breakdown.textContent).toContain(
      "agentHost.agentGui.turnStageGeneration"
    );
    expect(breakdown.textContent).toContain(
      "agentHost.agentGui.turnStageFinalization"
    );
  });

  it("keeps dynamic section spacing inside the animated height", () => {
    const expandedStore: AgentTurnDisclosureStore = {
      expandedOverrides: { "session-1:turn-1": true },
      setExpandedOverride: () => {}
    };
    const { container } = render(
      <AgentTurnWorkSection
        group={interleavedTurnGroup()}
        sessionId="session-1"
        turn={canonicalTurn({
          phase: "settled",
          outcome: "completed",
          settledAtUnixMs: 15_000
        })}
        isActiveTurn={false}
        disclosureStore={expandedStore}
        renderRow={(row) => <div key={row.id}>{row.id}</div>}
      />
    );

    expect(
      container.querySelector("[data-agent-turn-work-section]")
    ).toHaveClass("grid");
    expect(
      container.querySelector("[data-agent-turn-work-section]")
    ).not.toHaveClass("gap-4");
    expect(
      container.querySelector(".agent-collapsible-reveal__inner")
    ).toHaveClass("grid", "gap-4", "pt-4");
  });
});

function AgentTurnWorkSection({
  group,
  sessionId,
  turn,
  isActiveTurn,
  disclosureStore,
  renderRow
}: {
  group: AgentTranscriptTurnGroup;
  sessionId: string;
  turn: AgentActivityTurn;
  isActiveTurn: boolean;
  disclosureStore: AgentTurnDisclosureStore;
  renderRow: (
    row: AgentTranscriptRowVM,
    rowIndex: number,
    renderKey?: string
  ) => JSX.Element;
}): JSX.Element {
  const model = buildAgentTurnWorkSectionModel(group, turn, isActiveTurn, {
    collapseIntermediateAssistantReplies: true
  });
  if (!model) {
    throw new Error("Test expected a timing-enabled turn disclosure model");
  }
  return (
    <AgentTurnWorkSectionView
      model={model}
      sessionId={sessionId}
      turnKey={group.turnId ?? group.key}
      disclosureStore={disclosureStore}
      renderRow={renderRow}
    />
  );
}

function canonicalTurn(
  overrides: Partial<AgentActivityTurn> = {}
): AgentActivityTurn {
  return {
    agentSessionId: "session-1",
    origin: "user_prompt",
    phase: "running",
    startedAtUnixMs: 5_000,
    turnId: "turn-1",
    updatedAtUnixMs: 6_000,
    ...overrides
  };
}

function turnGroup(): AgentTranscriptTurnGroup {
  const row: AgentTranscriptRowVM = {
    kind: "message",
    id: "user-row",
    turnId: "turn-1",
    speaker: "user",
    messages: [
      {
        kind: "message-content",
        id: "user-message",
        turnId: "turn-1",
        body: "Please fix it",
        presentationKind: "content",
        occurredAtUnixMs: 5_000
      }
    ],
    thinking: [],
    occurredAtUnixMs: 5_000
  };
  return {
    key: "turn-1",
    turnId: "turn-1",
    rows: [{ row, rowIndex: 0 }]
  };
}

function interleavedTurnGroup(): AgentTranscriptTurnGroup {
  const messageRow = (
    id: string,
    speaker: "user" | "assistant",
    body: string,
    isTurnFinalText = false
  ): AgentTranscriptRowVM => ({
    kind: "message",
    id,
    turnId: "turn-1",
    speaker,
    messages: [
      {
        kind: "message-content",
        id: `${id}:message`,
        turnId: "turn-1",
        body,
        presentationKind: "content",
        copyText: isTurnFinalText ? body : null,
        ...(isTurnFinalText ? { isTurnFinalText: true as const } : {}),
        occurredAtUnixMs: 5_000
      }
    ],
    thinking: [],
    occurredAtUnixMs: 5_000
  });
  const rows: AgentTranscriptRowVM[] = [
    messageRow("user-1", "user", "First request"),
    messageRow("assistant-1", "assistant", "Earlier answer"),
    messageRow("user-2", "user", "Follow-up"),
    {
      kind: "tool-group",
      id: "tools",
      turnId: "turn-1",
      grouped: true,
      calls: [],
      entries: [],
      occurredAtUnixMs: 8_000
    },
    messageRow("assistant-2", "assistant", "Final answer", true)
  ];
  return {
    key: "turn-1",
    turnId: "turn-1",
    rows: rows.map((row, rowIndex) => ({ row, rowIndex }))
  };
}
