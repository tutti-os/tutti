import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUIProviderReadinessGate } from "../../../types.ts";
import type { AgentGUIViewLabels } from "../AgentGUINodeView.tsx";
import { AgentGUIProviderReadinessGatePane } from "./AgentGUIEmptyState.tsx";

vi.mock("./AgentGUIEmptyHeroCarouselStage.tsx", () => ({
  AgentGUIEmptyHeroCarouselStage: ({
    children
  }: {
    children: React.ReactNode;
  }) => <>{children}</>
}));

const labels = {
  providerGateCheckingTitle: "Checking",
  providerGateCheckingDescription: "Checking provider",
  providerGateCheckingAgentsDescription: "Checking agents",
  providerGateInstallTitle: "Connect provider",
  providerGateInstallDescription: "Connect before chatting",
  providerGateInstallAction: "Connect",
  providerGateLoginTitle: "Log in",
  providerGateLoginDescription: "Log in before chatting",
  providerGateLoginAction: "Log in",
  providerGateModelPlanAction: "Configure model plan",
  providerGateComingSoonTitle: "Coming soon",
  providerGateComingSoonDescription: "Coming soon",
  providerGateComingSoonAction: "Coming soon",
  providerGateUnavailableTitle: "Unavailable",
  providerGateUnavailableDescription: "Unavailable",
  providerGateRetryAction: "Retry",
  providerGateRuntimeSelectionTitle: "Choose runtime",
  providerGateRuntimeSelectionDescription: "Choose runtime",
  providerGateRuntimeSelectionAction: "Choose",
  providerGatePendingInstall: "Connecting",
  providerGatePendingLogin: "Opening login",
  providerGatePendingRefresh: "Checking",
  sharedAgentOwnerSeparator: "'s"
} as unknown as AgentGUIViewLabels;

describe("AgentGUI provider readiness model-plan action", () => {
  it.each(["auth_required", "not_installed"] as const)(
    "opens model-plan settings from the %s gate when the provider supports Tutti model plans",
    (status) => {
      const onModelPlanSetup = vi.fn();

      renderGate({
        status,
        onModelPlanSetup
      });

      fireEvent.click(
        screen.getByRole("button", { name: "Configure model plan" })
      );

      expect(onModelPlanSetup).toHaveBeenCalledOnce();
    }
  );

  it("keeps model-plan settings hidden when a non-Tutti host omits the capability", () => {
    renderGate({ status: "auth_required" });

    expect(
      screen.queryByRole("button", { name: "Configure model plan" })
    ).not.toBeInTheDocument();
  });
});

function renderGate(gate: AgentGUIProviderReadinessGate): void {
  render(
    <AgentGUIProviderReadinessGatePane
      provider="claude-code"
      gate={gate}
      emptyLabel="What can Claude Code help you with?"
      agentTargets={[]}
      avatarPresentations={[]}
      providerLabel="Claude Code"
      providerSelectLabel="Select Agent"
      selectedAgentTarget={null}
      labels={labels}
    />
  );
}
