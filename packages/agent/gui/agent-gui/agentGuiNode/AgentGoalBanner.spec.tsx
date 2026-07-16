import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentGoalBanner,
  describeGoal,
  formatGoalElapsed,
  goalStatusTitle,
  isGoalBannerVisible,
  type AgentGoalBannerLabels
} from "./AgentGoalBanner";

const labels: AgentGoalBannerLabels = {
  titleActive: "Active goal",
  titlePaused: "Paused goal",
  titleBlocked: "Blocked goal",
  titleUsageLimited: "Usage-limited goal",
  titleBudgetLimited: "Budget-limited goal",
  titleComplete: "Completed goal",
  budgetUsage: (used, budget) => `${used}/${budget} tokens`,
  clearHint: "Type /goal clear to clear",
  editAction: "Edit goal",
  pauseAction: "Pause goal",
  resumeAction: "Resume goal",
  clearAction: "Delete goal"
};

describe("isGoalBannerVisible", () => {
  it("is hidden when the objective is empty", () => {
    expect(isGoalBannerVisible("", "active")).toBe(false);
    expect(isGoalBannerVisible("   ", "active")).toBe(false);
    expect(isGoalBannerVisible(null, "active")).toBe(false);
  });

  it("is hidden for terminal statuses", () => {
    expect(isGoalBannerVisible("Ship it", "complete")).toBe(false);
    expect(isGoalBannerVisible("Ship it", "Completed")).toBe(false);
    expect(isGoalBannerVisible("Ship it", "done")).toBe(false);
  });

  it("is visible for non-terminal statuses with an objective", () => {
    expect(isGoalBannerVisible("Ship it", "active")).toBe(true);
    expect(isGoalBannerVisible("Ship it", "paused")).toBe(true);
    expect(isGoalBannerVisible("Ship it", "")).toBe(true);
  });
});

describe("goalStatusTitle", () => {
  it("maps statuses onto the leading banner title", () => {
    expect(goalStatusTitle("active", labels)).toBe("Active goal");
    expect(goalStatusTitle("paused", labels)).toBe("Paused goal");
    expect(goalStatusTitle("usageLimited", labels)).toBe("Usage-limited goal");
    expect(goalStatusTitle("", labels)).toBe("Active goal");
  });
});

describe("formatGoalElapsed", () => {
  it("renders compact elapsed time", () => {
    expect(formatGoalElapsed(2)).toBe("2s");
    expect(formatGoalElapsed(59)).toBe("59s");
    expect(formatGoalElapsed(60)).toBe("1m");
    expect(formatGoalElapsed(312)).toBe("5m 12s");
    expect(formatGoalElapsed(3840)).toBe("1h 4m");
    expect(formatGoalElapsed(-3)).toBe("0s");
  });
});

describe("AgentGoalBanner", () => {
  it("builds the shared goal description text", () => {
    expect(
      describeGoal({
        objective: "Finish the migration",
        elapsedSeconds: 125,
        tokenBudget: 40000,
        tokensUsed: 1200,
        labels
      })
    ).toBe("Finish the migration · 2m 5s · 1200/40000 tokens");
  });

  it("renders the status title, objective, and elapsed time", () => {
    render(
      <AgentGoalBanner
        objective="Finish the migration"
        status="active"
        durationMs={2000}
        labels={labels}
      />
    );

    const banner = screen.getByTestId("agent-gui-goal-banner");
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.textContent).toContain("Active goal");
    expect(banner.textContent).toContain("Finish the migration");
    expect(banner.textContent).toContain("2s");
    // Reuses the muted (informational) chrome card, not warning/danger.
    expect(banner.className).toContain("agent-gui-chrome__card--muted");
  });

  it("omits the elapsed time when the goal payload has none", () => {
    render(
      <AgentGoalBanner objective="No timer" status="paused" labels={labels} />
    );

    expect(
      screen.getByTestId("agent-gui-goal-banner-description").textContent
    ).toBe("No timer");
  });

  it("includes budget usage when a token budget is set", () => {
    render(
      <AgentGoalBanner
        objective="Keep tests green"
        status="active"
        tokenBudget={40000}
        tokensUsed={1200}
        labels={labels}
      />
    );

    expect(screen.getByTestId("agent-gui-goal-banner").textContent).toContain(
      "1200/40000 tokens"
    );
  });

  it("renders the clear hint when no action callbacks are provided", () => {
    render(
      <AgentGoalBanner objective="Read only" status="active" labels={labels} />
    );

    expect(
      screen.getByTestId("agent-gui-goal-banner-clear-hint").textContent
    ).toBe("Type /goal clear to clear");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers edit, pause, and delete actions for an active goal", () => {
    const onEditObjective = vi.fn();
    const onPauseGoal = vi.fn();
    const onResumeGoal = vi.fn();
    const onClearGoal = vi.fn();
    render(
      <AgentGoalBanner
        objective="Ship it"
        status="active"
        labels={labels}
        onEditObjective={onEditObjective}
        onPauseGoal={onPauseGoal}
        onResumeGoal={onResumeGoal}
        onClearGoal={onClearGoal}
      />
    );

    expect(screen.queryByTestId("agent-gui-goal-banner-clear-hint")).toBeNull();
    expect(screen.queryByTestId("agent-gui-goal-banner-resume")).toBeNull();
    fireEvent.click(screen.getByTestId("agent-gui-goal-banner-pause"));
    fireEvent.click(screen.getByTestId("agent-gui-goal-banner-clear"));
    expect(onPauseGoal).toHaveBeenCalledTimes(1);
    expect(onClearGoal).toHaveBeenCalledTimes(1);
    expect(onResumeGoal).not.toHaveBeenCalled();
    expect(onEditObjective).not.toHaveBeenCalled();
  });

  it("edits the objective inline and confirms with Enter", () => {
    const onEditObjective = vi.fn();
    render(
      <AgentGoalBanner
        objective="Ship it"
        status="active"
        labels={labels}
        onEditObjective={onEditObjective}
      />
    );

    fireEvent.click(screen.getByTestId("agent-gui-goal-banner-edit"));
    const input = screen.getByTestId(
      "agent-gui-goal-banner-edit-input"
    ) as HTMLInputElement;
    expect(input.value).toBe("Ship it");
    fireEvent.change(input, { target: { value: "Ship it faster" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEditObjective).toHaveBeenCalledWith("Ship it faster");
    expect(screen.queryByTestId("agent-gui-goal-banner-edit-input")).toBeNull();
  });

  it("cancels the inline edit with Escape without applying", () => {
    const onEditObjective = vi.fn();
    render(
      <AgentGoalBanner
        objective="Ship it"
        status="active"
        labels={labels}
        onEditObjective={onEditObjective}
      />
    );

    fireEvent.click(screen.getByTestId("agent-gui-goal-banner-edit"));
    const input = screen.getByTestId("agent-gui-goal-banner-edit-input");
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onEditObjective).not.toHaveBeenCalled();
    expect(screen.queryByTestId("agent-gui-goal-banner-edit-input")).toBeNull();
  });

  it.each(["paused", "blocked", "usageLimited", "budgetLimited"])(
    "offers resume and delete actions for a %s goal",
    (status) => {
      const onPauseGoal = vi.fn();
      const onResumeGoal = vi.fn();
      const onClearGoal = vi.fn();
      render(
        <AgentGoalBanner
          objective="Ship it"
          status={status}
          labels={labels}
          onPauseGoal={onPauseGoal}
          onResumeGoal={onResumeGoal}
          onClearGoal={onClearGoal}
        />
      );

      expect(screen.queryByTestId("agent-gui-goal-banner-pause")).toBeNull();
      fireEvent.click(screen.getByTestId("agent-gui-goal-banner-resume"));
      fireEvent.click(screen.getByTestId("agent-gui-goal-banner-clear"));
      expect(onResumeGoal).toHaveBeenCalledTimes(1);
      expect(onClearGoal).toHaveBeenCalledTimes(1);
      expect(onPauseGoal).not.toHaveBeenCalled();
    }
  );

  describe("elapsed ticking", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("ticks the elapsed time locally while the goal is active", () => {
      render(
        <AgentGoalBanner
          objective="Ship it"
          status="active"
          durationMs={2000}
          labels={labels}
        />
      );

      const description = () =>
        screen.getByTestId("agent-gui-goal-banner-description").textContent;
      expect(description()).toBe("Ship it · 2s");
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(description()).toBe("Ship it · 5s");
    });

    it("does not tick while the goal is paused", () => {
      render(
        <AgentGoalBanner
          objective="Ship it"
          status="paused"
          durationMs={40000}
          labels={labels}
        />
      );

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(
        screen.getByTestId("agent-gui-goal-banner-description").textContent
      ).toBe("Ship it · 40s");
    });

    it("starts an active goal at zero when the optional duration is omitted", () => {
      render(
        <AgentGoalBanner objective="Ship it" status="active" labels={labels} />
      );

      const description = () =>
        screen.getByTestId("agent-gui-goal-banner-description").textContent;
      expect(description()).toBe("Ship it · 0s");
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(description()).toBe("Ship it · 3s");
    });

    it("does not show or start elapsed time for an optimistic goal", () => {
      const { rerender } = render(
        <AgentGoalBanner
          objective="Ship it"
          status="active"
          durationMs={4000}
          optimistic={true}
          labels={labels}
        />
      );

      const description = () =>
        screen.getByTestId("agent-gui-goal-banner-description").textContent;
      expect(description()).toBe("Ship it");
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(description()).toBe("Ship it");

      rerender(
        <AgentGoalBanner
          objective="Ship it"
          status="active"
          durationMs={7000}
          optimistic={false}
          labels={labels}
        />
      );
      expect(description()).toBe("Ship it · 7s");
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(description()).toBe("Ship it · 9s");
    });
  });
});
