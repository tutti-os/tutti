import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import { AgentGUIConversationRailRelativeTime } from "./AgentGUIConversationRailClock";

describe("AgentGUIConversationRailRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses one timer and updates only relative-time consumers", () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    let rowRenderCount = 0;

    function StableRow({ item }: { item: AgentGUIConversationSummary }) {
      rowRenderCount += 1;
      return (
        <div>
          <span>{item.title}</span>
          <AgentGUIConversationRailRelativeTime
            item={item}
            labels={RELATIVE_TIME_LABELS}
          />
        </div>
      );
    }

    const { unmount } = render(
      <>
        <StableRow item={createConversation("session-1")} />
        <StableRow item={createConversation("session-2")} />
      </>
    );

    expect(rowRenderCount).toBe(2);
    expect(
      setIntervalSpy.mock.calls.filter((call) => call[1] === 60_000)
    ).toHaveLength(1);
    expect(screen.getAllByText("just now")).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(rowRenderCount).toBe(2);
    expect(screen.getAllByText("1 minute")).toHaveLength(2);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function createConversation(id: string): AgentGUIConversationSummary {
  return {
    cwd: "/workspace",
    id,
    provider: "codex",
    status: "ready",
    title: id,
    updatedAtUnixMs: 1_000_000
  };
}

const RELATIVE_TIME_LABELS = {
  relativeTimeDays: (value: number) => `${value} days`,
  relativeTimeHours: (value: number) => `${value} hours`,
  relativeTimeJustNow: "just now",
  relativeTimeMinutes: (value: number) =>
    `${value} ${value === 1 ? "minute" : "minutes"}`,
  relativeTimeMonths: (value: number) => `${value} months`,
  relativeTimeYears: (value: number) => `${value} years`
};
