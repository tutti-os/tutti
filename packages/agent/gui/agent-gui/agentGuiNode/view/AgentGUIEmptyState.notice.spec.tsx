import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentComposerProps } from "../AgentComposer";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";
import {
  AgentGUIEmptyHeroPane,
  AgentGUIEmptyHomePane
} from "./AgentGUIEmptyState";

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

  it("renders target connection chrome above the Home composer", () => {
    render(
      <AgentGUIEmptyHeroPane
        provider="codex"
        emptyLabel="What can Codex help you with?"
        emptyProvider="Codex"
        avatarPresentations={[
          {
            agentTargetId: "shared:codex",
            iconUrl: "/codex.png",
            label: "Codex",
            provider: "codex",
            targetId: "shared:codex"
          }
        ]}
        noticeChrome={{
          auth: null,
          approval: null,
          recovery: {
            kind: "transport-connecting",
            message: "Connecting to the device...",
            canRetry: false
          },
          rawState: null
        }}
        isRespondingApproval={false}
        onSubmitApprovalOption={vi.fn()}
        onRetryActivation={vi.fn()}
        onContinueInNewConversation={vi.fn()}
        agentTargets={[]}
        selectedAgentTarget={null}
        chromeLabels={{
          approvalRequired: "Approval required",
          authRequired: "Authentication required",
          activatingSession: "Connecting session...",
          retryActivation: "Retry",
          continueInNewConversation: "Continue in new session"
        }}
        composerProps={{} as AgentComposerProps}
        providerSelectLabel="Select agent"
        sharedAgentOwnerSeparator="'s "
        suggestions={[]}
        onSelectSuggestion={vi.fn()}
      />
    );

    const connectionNotice = screen.getByRole("status");
    const composer = screen.getByTestId("agent-composer");

    expect(connectionNotice).toHaveTextContent("Connecting to the device");
    expect(
      connectionNotice.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
