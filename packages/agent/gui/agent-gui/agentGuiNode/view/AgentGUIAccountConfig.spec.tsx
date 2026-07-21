import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentGUIConfigMenu } from "./AgentGUIAccountConfig";

describe("AgentGUIConfigMenu status", () => {
  it("renders a successful empty limits result as an em dash", () => {
    render(
      <AgentGUIConfigMenu
        environmentSetupVisible={false}
        labels={
          {
            agentConfig: "Config",
            slashStatusLimits: "Limits",
            slashStatusEmptyValue: "—",
            slashStatusLimitsUnavailable: "Unavailable",
            slashStatusUsageJustUpdated: "Updated",
            slashStatusUsageMinutesAgo: (count: number) => `${count}m`,
            slashStatusUsageHoursAgo: (count: number) => `${count}h`,
            slashStatusUsageUpdating: "Updating",
            slashStatusUsageRefreshFailed: "Failed",
            slashStatusUsageRefreshAria: "Refresh"
          } as never
        }
        previewMode={false}
        providerScopedActionsVisible
        slashStatusLimits={[]}
        slashStatusLimitsLoading={false}
        slashStatusLimitsResolvedEmpty
        slashStatusUsageCapturedAtUnixMs={1}
        slashStatusUsageDidFail={false}
        slashStatusUsageAttempted
        provider="codex"
        onOpenAgentEnvSetup={vi.fn()}
        onOpenAgentSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Config" }));

    expect(
      screen.getByTestId("agent-gui-config-usage-unavailable")
    ).toHaveTextContent("—");
  });
});
