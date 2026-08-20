import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";
import {
  AgentGUIConfigAccountFallbackSuppressed,
  AgentGUIConfigMenu
} from "./AgentGUIAccountConfig";

afterEach(cleanup);

const labels = {
  agentConfig: "More",
  slashStatusProviderAccount: (provider: string) => `${provider} account`,
  slashStatusAccount: "Account",
  slashStatusLimits: "Limits",
  slashStatusEmptyValue: "--",
  slashStatusLimitsUnavailable: "Unavailable",
  slashStatusUsageJustUpdated: "Updated",
  slashStatusUsageMinutesAgo: () => "Minutes ago",
  slashStatusUsageHoursAgo: () => "Hours ago",
  slashStatusUsageUpdating: "Updating",
  slashStatusUsageRefreshFailed: "Refresh failed",
  slashStatusUsageRefreshAria: "Refresh usage",
  agentEnvSetup: "Environment",
  agentSettingsMenu: "Settings"
} as unknown as AgentGUIViewLabels;

describe("AgentGUIConfigMenu", () => {
  it("keeps Host system actions interactive after Agent settings", () => {
    const onSystemAction = vi.fn();
    render(
      <AgentGUIConfigMenu
        environmentSetupVisible={false}
        labels={labels}
        providerScopedActionsVisible
        slashStatusLimits={[]}
        slashStatusLimitsLoading={false}
        slashStatusLimitsResolvedEmpty={false}
        slashStatusUsageCapturedAtUnixMs={null}
        slashStatusUsageDidFail={false}
        slashStatusUsageAttempted={false}
        systemActionsContent={
          <button type="button" onClick={onSystemAction}>
            Check for updates
          </button>
        }
        onOpenAgentEnvSetup={vi.fn()}
        onOpenAgentSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(onSystemAction).toHaveBeenCalledOnce();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("replaces provider quota chrome only when the Host supplies account content", () => {
    const onOpen = vi.fn();
    render(
      <AgentGUIConfigMenu
        accountContent={<div>Host Commerce account</div>}
        environmentSetupVisible={false}
        labels={labels}
        providerScopedActionsVisible
        provider="tutti-agent"
        providerAuthAccountLabel="provider@example.test"
        slashStatusLimits={[]}
        slashStatusLimitsLoading={false}
        slashStatusLimitsResolvedEmpty={false}
        slashStatusUsageCapturedAtUnixMs={null}
        slashStatusUsageDidFail={false}
        slashStatusUsageAttempted
        onAgentConfigMenuOpen={onOpen}
        onOpenAgentEnvSetup={vi.fn()}
        onOpenAgentSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.getByText("Host Commerce account")).toBeInTheDocument();
    expect(screen.queryByText("provider@example.test")).not.toBeInTheDocument();
    expect(screen.queryByText("Limits")).not.toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("preserves the provider account and quota fallback without Host content", () => {
    render(
      <AgentGUIConfigMenu
        environmentSetupVisible={false}
        labels={labels}
        providerScopedActionsVisible
        provider="codex"
        providerAuthAccountLabel="provider@example.test"
        slashStatusLimits={[
          {
            id: "weekly",
            label: "Weekly",
            percentRemaining: 50,
            value: "50%",
            reset: null
          }
        ]}
        slashStatusLimitsLoading={false}
        slashStatusLimitsResolvedEmpty={false}
        slashStatusUsageCapturedAtUnixMs={null}
        slashStatusUsageDidFail={false}
        slashStatusUsageAttempted
        onAgentConfigMenuOpen={vi.fn()}
        onOpenAgentEnvSetup={vi.fn()}
        onOpenAgentSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(screen.getByText("provider@example.test")).toBeInTheDocument();
    expect(screen.getByText("Limits")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
  });

  it("uses the Agent Target label and original icon for Kimi billing", () => {
    render(
      <AgentGUIConfigMenu
        environmentSetupVisible={false}
        labels={labels}
        providerScopedActionsVisible
        provider="acp:kimi-code"
        providerIconUrl="kimi-code.png"
        providerMaskIconUrl="kimi-code-mask.png"
        providerLabel="Kimi Code"
        providerAuthAccountLabel="API Usage Billing"
        slashStatusLimits={[]}
        slashStatusLimitsLoading={false}
        slashStatusLimitsResolvedEmpty
        slashStatusUsageCapturedAtUnixMs={500}
        slashStatusUsageDidFail={false}
        slashStatusUsageAttempted
        onAgentConfigMenuOpen={vi.fn()}
        onOpenAgentEnvSetup={vi.fn()}
        onOpenAgentSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(screen.getByText("Kimi Code account")).toBeInTheDocument();
    expect(screen.getByText("API Usage Billing")).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-gui-config-usage-unavailable")
    ).toHaveTextContent("--");
    expect(
      document.querySelector('img[src="kimi-code.png"]')
    ).toBeInTheDocument();
    expect(
      document.querySelector('span[style*="kimi-code-mask.png"]')
    ).toBeNull();
  });

  it.each(["Coding Plan", "CodeBuddy Account"])(
    "shows unavailable account quota copy for %s billing",
    (providerAuthAccountLabel) => {
      render(
        <AgentGUIConfigMenu
          environmentSetupVisible={false}
          labels={labels}
          providerScopedActionsVisible
          provider="acp:codebuddy"
          providerLabel="CodeBuddy"
          providerAuthAccountLabel={providerAuthAccountLabel}
          slashStatusLimits={[]}
          slashStatusLimitsLoading={false}
          slashStatusLimitsResolvedEmpty={false}
          slashStatusUsageCapturedAtUnixMs={500}
          slashStatusUsageDidFail={false}
          slashStatusUsageAttempted
          onAgentConfigMenuOpen={vi.fn()}
          onOpenAgentEnvSetup={vi.fn()}
          onOpenAgentSettings={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "More" }));

      expect(screen.getByText(providerAuthAccountLabel)).toBeInTheDocument();
      expect(
        screen.getByTestId("agent-gui-config-usage-unavailable")
      ).toHaveTextContent("Unavailable");
    }
  );

  it("uses a custom mask only when no original icon exists", () => {
    render(
      <AgentGUIConfigMenu
        environmentSetupVisible={false}
        labels={labels}
        providerScopedActionsVisible
        provider="acp:custom"
        providerMaskIconUrl="custom-mask.png"
        providerLabel="Custom"
        providerAuthAccountLabel="Signed in"
        slashStatusLimits={[]}
        slashStatusLimitsLoading={false}
        slashStatusLimitsResolvedEmpty
        slashStatusUsageCapturedAtUnixMs={null}
        slashStatusUsageDidFail={false}
        slashStatusUsageAttempted
        onOpenAgentEnvSetup={vi.fn()}
        onOpenAgentSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(
      document.querySelector('span[style*="custom-mask.png"]')
    ).toBeInTheDocument();
  });

  it("shows an actionable account error instead of an unavailable placeholder", () => {
    render(
      <AgentGUIConfigMenu
        environmentSetupVisible
        labels={labels}
        providerScopedActionsVisible
        provider="acp:kimi-code"
        slashStatusLimits={[]}
        slashStatusLimitsLoading={false}
        slashStatusLimitsResolvedEmpty={false}
        slashStatusUsageCapturedAtUnixMs={null}
        slashStatusUsageDidFail
        slashStatusUsageErrorMessage="Configure an API key or sign in"
        slashStatusUsageAttempted
        onOpenAgentEnvSetup={vi.fn()}
        onOpenAgentSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Configure an API key or sign in"
    );
    expect(
      screen.queryByTestId("agent-gui-config-usage-unavailable")
    ).not.toBeInTheDocument();
  });

  it.each([false, true, 0, ""])(
    "preserves the provider fallback for non-rendering Host content %#",
    (accountContent) => {
      render(
        <AgentGUIConfigMenu
          accountContent={accountContent}
          environmentSetupVisible={false}
          labels={labels}
          providerScopedActionsVisible
          provider="codex"
          providerAuthAccountLabel="provider@example.test"
          slashStatusLimits={[
            {
              id: "weekly",
              label: "Weekly",
              percentRemaining: 50,
              value: "50%",
              reset: null
            }
          ]}
          slashStatusLimitsLoading={false}
          slashStatusLimitsResolvedEmpty={false}
          slashStatusUsageCapturedAtUnixMs={null}
          slashStatusUsageDidFail={false}
          slashStatusUsageAttempted
          onAgentConfigMenuOpen={vi.fn()}
          onOpenAgentEnvSetup={vi.fn()}
          onOpenAgentSettings={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "More" }));

      expect(screen.getByText("provider@example.test")).toBeInTheDocument();
      expect(screen.getByText("Limits")).toBeInTheDocument();
      expect(screen.getByText("Weekly")).toBeInTheDocument();
    }
  );

  it("hides generic account and usage rows when Host claims the surface without content", () => {
    render(
      <AgentGUIConfigMenu
        environmentSetupVisible={false}
        labels={labels}
        providerScopedActionsVisible
        accountContent={<AgentGUIConfigAccountFallbackSuppressed />}
        provider="tutti-agent"
        providerAuthAccountLabel="233749"
        slashStatusLimits={[]}
        slashStatusLimitsLoading={false}
        slashStatusLimitsResolvedEmpty={false}
        slashStatusUsageCapturedAtUnixMs={null}
        slashStatusUsageDidFail
        slashStatusUsageAttempted
        onAgentConfigMenuOpen={vi.fn()}
        onOpenAgentEnvSetup={vi.fn()}
        onOpenAgentSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(screen.queryByText("Limits")).not.toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Refresh failed")).not.toBeInTheDocument();
    expect(screen.queryByText("tutti-agent account")).not.toBeInTheDocument();
    expect(screen.queryByText("233749")).not.toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("shows the localized stable usage error in the provider fallback", () => {
    render(
      <AgentGUIConfigMenu
        environmentSetupVisible={false}
        labels={labels}
        providerScopedActionsVisible
        provider="acp:kimi-code"
        providerAuthAccountLabel="Coding Plan"
        slashStatusLimits={[]}
        slashStatusLimitsLoading={false}
        slashStatusLimitsResolvedEmpty={false}
        slashStatusUsageCapturedAtUnixMs={null}
        slashStatusUsageDidFail
        slashStatusUsageErrorMessage="Coding Plan required"
        slashStatusUsageAttempted
        onAgentConfigMenuOpen={vi.fn()}
        onOpenAgentEnvSetup={vi.fn()}
        onOpenAgentSettings={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(screen.getByText("Coding Plan required")).toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
  });
});
