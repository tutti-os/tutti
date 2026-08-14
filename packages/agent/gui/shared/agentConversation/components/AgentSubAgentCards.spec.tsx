import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("does not tick while queued for a concurrency slot, even as time passes", async () => {
    setAgentGuiI18nTestLocale("en");
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    render(
      <AgentSubAgentCard
        subAgent={subAgent({
          status: "running",
          queued: true,
          startedAtUnixMs: 1_000,
          latestActivityAtUnixMs: 1_000
        })}
      />
    );

    expect(
      screen.getByText("Queued — waiting for an agent slot…")
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });

    // A queued sub-agent has not been dispatched yet: startedAtUnixMs is the
    // spawn call's own (dispatch) time, not a real run-start time, so no
    // elapsed clock must appear or tick while queued=true.
    expect(screen.queryByText(/\d+(\.\d+)?s ·/)).not.toBeInTheDocument();
    expect(
      screen.getByText("Queued — waiting for an agent slot…")
    ).toBeInTheDocument();
  });

  it("starts ticking only once dispatch clears the queue", async () => {
    setAgentGuiI18nTestLocale("en");
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const { rerender } = render(
      <AgentSubAgentCard
        subAgent={subAgent({
          status: "running",
          queued: true,
          startedAtUnixMs: 1_000,
          latestActivityAtUnixMs: 1_000
        })}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(screen.queryByText(/\d+(\.\d+)?s ·/)).not.toBeInTheDocument();

    // The sub-agent clears the queue at t=10_000 and actually starts running.
    vi.setSystemTime(10_000);
    rerender(
      <AgentSubAgentCard
        subAgent={subAgent({
          status: "running",
          queued: false,
          startedAtUnixMs: 10_000,
          latestActivityAtUnixMs: 10_000
        })}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(screen.getByText(/2\.0s · Running/)).toBeInTheDocument();
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

  it("shows completed instead of starting when terminal output is absent", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentSubAgentCard
        subAgent={subAgent({
          status: "completed",
          terminalAtUnixMs: 2_000
        })}
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Sub-agent Repo smell analyst Completed/
      })
    );
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText("Starting…")).not.toBeInTheDocument();
  });

  it("shows failed instead of starting when failure detail is absent", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentSubAgentCard
        subAgent={subAgent({
          status: "failed",
          terminalAtUnixMs: 2_000
        })}
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Sub-agent Repo smell analyst Failed/
      })
    );
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });

    expect(
      screen.getByText("Failed", {
        selector:
          ".workspace-agents-status-panel__detail-subagent-activity--in-terminal"
      })
    ).toBeInTheDocument();
    expect(screen.queryByText("Starting…")).not.toBeInTheDocument();
  });

  it("renders a completed Markdown result without duplicating its progress summary", async () => {
    setAgentGuiI18nTestLocale("en");
    const onLinkClick = vi.fn();

    render(
      <AgentSubAgentCard
        onLinkClick={onLinkClick}
        subAgent={subAgent({
          status: "completed",
          latestActivity: "Full result",
          resultMarkdown: "## Full result\n\n[report](https://example.com/report.pdf)",
          terminalAtUnixMs: 2_000,
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Sub-agent Repo smell analyst Completed/,
      }),
    );
    expect(await screen.findByRole("heading", { name: "Full result" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "report" }));
    expect(onLinkClick).toHaveBeenCalledWith("https://example.com/report.pdf");
    expect(screen.queryByText("Full result", { selector: "div" })).not.toBeInTheDocument();
  });
});

function subAgent(
  overrides: Partial<AgentTaskSubAgentVM> = {}
): AgentTaskSubAgentVM {
  return {
    childSessionId: "child-session-1",
    parentToolCallId: "spawn-1",
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
    childSessions: [],
    ...overrides
  };
}
