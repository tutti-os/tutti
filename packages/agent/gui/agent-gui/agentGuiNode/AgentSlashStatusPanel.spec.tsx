import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AgentSlashStatusPanel,
  type AgentSlashStatusPanelLabels
} from "./AgentSlashStatusPanel";

const labels: AgentSlashStatusPanelLabels = {
  slashStatusTitle: "Status",
  slashStatusSession: "Session",
  slashStatusBaseUrl: "Base URL",
  slashStatusContext: "Context",
  slashStatusLimits: "Limits",
  slashStatusClose: "Close",
  slashStatusContextValue: ({ percentLeft }) => `${percentLeft}% left`,
  slashStatusContextUnavailable: "—",
  slashStatusLimitsUnavailable: "Unavailable",
  slashStatusEmptyValue: "—",
  slashStatusUsageJustUpdated: "Updated just now",
  slashStatusUsageMinutesAgo: (count) => `Updated ${count}m ago`,
  slashStatusUsageHoursAgo: (count) => `Updated ${count}h ago`,
  slashStatusUsageUpdating: "Updating…",
  slashStatusUsageRefreshFailed: "Refresh failed",
  slashStatusUsageRefreshAria: "Refresh status"
};

describe("AgentSlashStatusPanel", () => {
  it("renders the lightweight canonical fields and omits endpoint details", () => {
    render(
      <AgentSlashStatusPanel
        labels={labels}
        status={{
          agentSessionId: "session-1",
          baseUrl: "https://private.example.test",
          contextWindow: { usedTokens: 250, totalTokens: 1_000 },
          limits: [],
          limitsResolvedEmpty: true
        }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("session-1")).toBeInTheDocument();
    expect(screen.getByText("75% left")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("Base URL:")).not.toBeInTheDocument();
    expect(
      screen.queryByText("https://private.example.test")
    ).not.toBeInTheDocument();
  });

  it("shows loading immediately and exposes refresh/close actions", () => {
    const onClose = vi.fn();
    const onRefresh = vi.fn();
    const { rerender } = render(
      <AgentSlashStatusPanel
        labels={labels}
        status={{ limits: [], limitsLoading: true, isRefreshing: true }}
        onClose={onClose}
        onRefresh={onRefresh}
      />
    );

    expect(screen.getAllByText("Updating…")).toHaveLength(2);
    expect(screen.getByText("Context:")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh status" })
    ).toHaveAttribute("aria-busy", "true");

    rerender(
      <AgentSlashStatusPanel
        labels={labels}
        status={{
          limits: [],
          limitsResolvedEmpty: true,
          limitsCapturedAtUnixMs: Date.now()
        }}
        onClose={onClose}
        onRefresh={onRefresh}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
