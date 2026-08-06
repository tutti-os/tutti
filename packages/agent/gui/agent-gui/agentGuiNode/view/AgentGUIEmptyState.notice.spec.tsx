import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentComposerProps } from "../AgentComposer";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";
import { AgentGUIEmptyHomePane } from "./AgentGUIEmptyState";

vi.mock("../AgentComposer", () => ({
  AgentComposer: () => <div data-testid="agent-composer" />
}));

vi.mock("./AgentGUIEmptyHeroCarouselStage", () => ({
  AgentGUIEmptyHeroCarouselStage: ({
    children
  }: {
    children: React.ReactNode;
  }) => <>{children}</>
}));

vi.mock("./AgentTargetSetupGate.tsx", () => ({
  AgentTargetSetupGate: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  )
}));

vi.mock("../../../i18n/index", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "agentHost.agentGui.updateNoticeRegionLabel" ? "CLI updates" : key
  })
}));

describe("AgentGUIEmptyHeroPane notices", () => {
  it("does not render an unresolved target label in the Home title", () => {
    render(
      <AgentGUIEmptyHomePane
        isActive
        isVisible
        provider="unknown"
        providerReadinessGate={null}
        showAllProviders={false}
        agentTargets={[]}
        selectedAgentTarget={{
          disabled: true,
          label: "unknown",
          provider: "unknown",
          ref: { kind: "loading", provider: "unknown" },
          targetId: "__loading__"
        }}
        labels={
          {
            empty: "需要 Agent 帮你做些什么？",
            emptyForProvider: () => "需要 Agent 帮你做些什么？",
            emptyProvider: "Agent",
            emptyProviderForProvider: () => "Agent",
            providerSwitchLabel: "选择 Agent",
            sharedAgentOwnerSeparator: "的"
          } as unknown as AgentGUIViewLabels
        }
        noticeChrome={null}
        isRespondingApproval={false}
        onSubmitApprovalOption={vi.fn()}
        onRetryActivation={vi.fn()}
        onContinueInNewConversation={vi.fn()}
        chromeLabels={{} as never}
        composerProps={{} as AgentComposerProps}
        suggestions={[]}
        onSelectSuggestion={vi.fn()}
      />
    );

    expect(
      screen.getByRole("heading", {
        name: "需要 Agent 帮你做些什么？"
      })
    ).toBeInTheDocument();
    expect(screen.queryByText(/unknown/i)).not.toBeInTheDocument();
  });

  it("reuses the Home status chrome for revoked sharing above the disabled composer", () => {
    render(
      <AgentGUIEmptyHomePane
        isActive
        isVisible
        provider="codex"
        providerReadinessGate={null}
        showAllProviders={false}
        agentTargets={[]}
        selectedAgentTarget={null}
        labels={
          {
            empty: "What can Agent help with?",
            emptyForProvider: () => "What can Agent help with?",
            emptyProvider: "Agent",
            emptyProviderForProvider: () => "Agent",
            providerSwitchLabel: "Select Agent",
            sharedAgentOwnerSeparator: "'s"
          } as unknown as AgentGUIViewLabels
        }
        noticeChrome={{
          auth: null,
          approval: null,
          recovery: {
            kind: "agent-sharing-revoked",
            message: "Jackson stopped sharing this agent",
            canRetry: false
          },
          rawState: null
        }}
        isRespondingApproval={false}
        onSubmitApprovalOption={vi.fn()}
        onRetryActivation={vi.fn()}
        onContinueInNewConversation={vi.fn()}
        chromeLabels={{} as never}
        composerProps={{} as AgentComposerProps}
        suggestions={[]}
        onSelectSuggestion={vi.fn()}
      />
    );

    const status = screen.getByRole("alert");
    const composer = screen.getByTestId("agent-composer");
    expect(status).toHaveTextContent("Jackson stopped sharing this agent");
    expect(
      status.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("shows Host update notices only on the ready empty Home surface", () => {
    const props = {
      isActive: true,
      isVisible: true,
      provider: "codex" as const,
      showAllProviders: false,
      agentTargets: [
        {
          agentTargetId: "local:codex",
          label: "Codex",
          provider: "codex" as const,
          ref: { kind: "local", provider: "codex" as const },
          targetId: "local:codex"
        }
      ],
      selectedAgentTarget: null,
      labels: {
        empty: "What can Agent help with?",
        emptyForProvider: () => "What can Agent help with?",
        emptyProvider: "Agent",
        emptyProviderForProvider: () => "Agent",
        providerSwitchLabel: "Select Agent",
        providerGateCheckingTitle: "Checking Agent",
        providerGateCheckingDescription: "Checking Agent readiness",
        providerGateCheckingAgentsDescription: "Checking Agent readiness",
        sharedAgentOwnerSeparator: "'s"
      } as unknown as AgentGUIViewLabels,
      noticeChrome: null,
      isRespondingApproval: false,
      onSubmitApprovalOption: vi.fn(),
      onRetryActivation: vi.fn(),
      onContinueInNewConversation: vi.fn(),
      chromeLabels: {} as never,
      composerProps: {} as AgentComposerProps,
      suggestions: [],
      onSelectSuggestion: vi.fn(),
      updateNotices: [
        {
          agentTargetId: "local:codex",
          currentVersion: "1.2.3",
          latestVersion: "1.3.0",
          phase: "available" as const
        }
      ],
      onUpdateNoticeAction: vi.fn()
    };
    const { rerender } = render(
      <AgentGUIEmptyHomePane {...props} providerReadinessGate={null} />
    );

    expect(
      screen.getByRole("region", { name: "CLI updates" })
    ).toBeInTheDocument();

    rerender(
      <AgentGUIEmptyHomePane
        {...props}
        providerReadinessGate={{ status: "checking" }}
      />
    );

    expect(
      screen.queryByRole("region", { name: "CLI updates" })
    ).not.toBeInTheDocument();

    rerender(
      <AgentGUIEmptyHomePane
        {...props}
        onUpdateNoticeAction={undefined}
        providerReadinessGate={null}
      />
    );

    expect(
      screen.queryByRole("region", { name: "CLI updates" })
    ).not.toBeInTheDocument();
  });
});
