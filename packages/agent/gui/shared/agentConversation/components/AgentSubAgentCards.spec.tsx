import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAgentGuiI18nTestLocale } from "../../../i18n/testUtils";
import type { AgentTaskSubAgentVM } from "../contracts/agentTaskItemVM";
import { AgentSubAgentCard } from "./AgentSubAgentCards";

describe("AgentSubAgentCard", () => {
  afterEach(() => {
    vi.useRealTimers();
    setAgentGuiI18nTestLocale("zh-CN");
  });

  it("keeps ticking while running even when no new sub-agent activity arrives", async () => {
    setAgentGuiI18nTestLocale("en");
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    render(
      <AgentSubAgentCard
        subAgent={subAgent({
          status: "running",
          startedAtUnixMs: 1_000,
          latestActivityAtUnixMs: 1_000
        })}
      />
    );

    expect(screen.getByText("Starting…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(screen.getByText(/2\.0s · Running/)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });

    expect(screen.getByText(/11s · Running/)).toBeInTheDocument();
  });

  it("freezes terminal elapsed time instead of following Date.now", async () => {
    setAgentGuiI18nTestLocale("en");
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    render(
      <AgentSubAgentCard
        subAgent={subAgent({
          status: "completed",
          startedAtUnixMs: 1_000,
          latestActivityAtUnixMs: 101_000,
          terminalAtUnixMs: 6_000
        })}
      />
    );

    expect(screen.getByText(/5\.0s · Completed/)).toBeInTheDocument();

    await act(async () => {
      vi.setSystemTime(120_000);
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByText(/5\.0s · Completed/)).toBeInTheDocument();
    expect(screen.queryByText(/1m 59s/)).not.toBeInTheDocument();
  });
});

function subAgent(
  overrides: Partial<AgentTaskSubAgentVM> = {}
): AgentTaskSubAgentVM {
  return {
    ownerThreadId: "child-thread-1",
    status: "running",
    name: "Repo smell analyst",
    task: "inspect the repository",
    laneIndex: 1,
    laneCount: 1,
    latestActivity: null,
    latestActivityKind: null,
    activityLog: [],
    activityOmittedCount: 0,
    failureDetail: null,
    startedAtUnixMs: 1_000,
    latestActivityAtUnixMs: 1_000,
    terminalAtUnixMs: null,
    ...overrides
  };
}
