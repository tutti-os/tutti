import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AgentGoalBanner,
  describeGoal,
  isGoalBannerVisible,
  type AgentGoalBannerLabels
} from "./AgentGoalBanner";

const labels: AgentGoalBannerLabels = {
  goalLabel: "Goal",
  statusActive: "Active",
  statusPaused: "Paused",
  statusBlocked: "Blocked",
  statusUsageLimited: "Usage limited",
  statusBudgetLimited: "Budget limited",
  statusComplete: "Complete",
  budgetUsage: (used, budget) => `${used}/${budget} tokens`,
  clearHint: "Type /goal clear to clear",
  pauseAction: "Pause",
  resumeAction: "Resume",
  clearAction: "End goal"
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

describe("AgentGoalBanner", () => {
  it("builds the shared goal description text", () => {
    expect(
      describeGoal({
        objective: "Finish the migration",
        status: "active",
        tokenBudget: 40000,
        tokensUsed: 1200,
        labels
      })
    ).toBe("Finish the migration · Active · 1200/40000 tokens");
  });

  it("renders the objective with the goal label and status", () => {
    render(
      <AgentGoalBanner
        objective="Finish the migration"
        status="active"
        labels={labels}
      />
    );

    const banner = screen.getByTestId("agent-gui-goal-banner");
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.textContent).toContain("Goal");
    expect(banner.textContent).toContain("Finish the migration");
    expect(banner.textContent).toContain("Active");
    // Reuses the muted (informational) chrome card, not warning/danger.
    expect(banner.className).toContain("agent-gui-chrome__card--muted");
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

  it("omits budget usage when no token budget is set", () => {
    render(
      <AgentGoalBanner objective="No budget" status="paused" labels={labels} />
    );

    const banner = screen.getByTestId("agent-gui-goal-banner");
    expect(banner.textContent).toContain("Paused");
    expect(banner.textContent).not.toContain("tokens");
  });

  it("renders the clear hint and no interactive clear control", () => {
    render(
      <AgentGoalBanner objective="Read only" status="active" labels={labels} />
    );

    expect(
      screen.getByTestId("agent-gui-goal-banner-clear-hint").textContent
    ).toBe("Type /goal clear to clear");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers pause and clear actions for an active goal", () => {
    const onPauseGoal = vi.fn();
    const onResumeGoal = vi.fn();
    const onClearGoal = vi.fn();
    render(
      <AgentGoalBanner
        objective="Ship it"
        status="active"
        labels={labels}
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
  });

  it.each(["paused", "blocked", "usageLimited", "budgetLimited"])(
    "offers resume and clear actions for a %s goal",
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
});
