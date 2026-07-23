import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentComposerProps } from "../AgentComposer";
import { AgentGUIEmptyHeroPane } from "./AgentGUIEmptyState";

vi.mock("../AgentComposer", () => ({
  AgentComposer: () => <div data-testid="agent-composer" />
}));

describe("AgentGUIEmptyHeroPane notices", () => {
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
