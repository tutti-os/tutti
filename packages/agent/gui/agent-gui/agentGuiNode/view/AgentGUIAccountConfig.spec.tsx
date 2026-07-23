import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AgentGUIAccountRailMenu,
  AgentGUIConfigMenu
} from "./AgentGUIAccountConfig";

describe("AgentGUIAccountRailMenu", () => {
  it("delegates user ID copying to the host callback", async () => {
    const onCopyUserId = vi.fn();
    render(
      <AgentGUIAccountRailMenu
        accountMenuState={{
          user: {
            userId: "user-123",
            name: "Tutti User"
          },
          membershipLabel: "Free",
          creditsLabel: null,
          loading: false,
          error: null,
          links: {
            planUrl: "",
            usageUrl: "",
            settingsUrl: ""
          },
          onOpenChange: vi.fn(),
          onLogin: vi.fn(),
          onCopyUserId,
          onOpenExternal: vi.fn()
        }}
        labels={
          {
            accountMenuCopyUserId: "Copy user ID",
            accountMenuFree: "Free",
            accountMenuLoading: "Loading",
            accountMenuUnavailable: "Unavailable",
            accountMenuDataUnavailable: "Unavailable"
          } as never
        }
        previewMode={false}
      />
    );

    fireEvent.contextMenu(screen.getByTestId("agent-gui-account-avatar"));
    fireEvent.click(await screen.findByText("Copy user ID"));

    expect(onCopyUserId).toHaveBeenCalledOnce();
  });
});

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
