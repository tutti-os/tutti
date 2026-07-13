import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@tutti-os/ui-system";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAgentMessageCenterAttentionDeck } from "./WorkspaceAgentMessageCenterAttentionDeck";
import type { WorkspaceAgentMessageCenterItem } from "./workspaceAgentMessageCenterModel";

function promptItem(
  overrides: Partial<WorkspaceAgentMessageCenterItem> & {
    agentSessionId: string;
  }
): WorkspaceAgentMessageCenterItem {
  return {
    id: `message-center-${overrides.agentSessionId}`,
    provider: "codex",
    userId: null,
    title: overrides.agentSessionId,
    identity: null,
    cwd: "/workspace",
    status: "waiting",
    digest: {
      primary: {
        kind: "input-required",
        summary: "Approval",
        occurredAtUnixMs: 1
      }
    },
    lastAgentMessageSummary: "",
    lastAgentMessageAtUnixMs: 1,
    needsAttentionKind: null,
    needsAttentionSummary: null,
    sortTimeUnixMs: 1,
    pendingPrompt: {
      kind: "approval",
      id: `approval:${overrides.agentSessionId}`,
      turnId: "turn-1",
      requestId: `request-${overrides.agentSessionId}`,
      callId: `request-${overrides.agentSessionId}`,
      title: "Approval",
      status: "waiting_approval",
      toolName: "Bash",
      input: null,
      options: [
        { id: "allow_once", label: "Yes", kind: "allow_once", description: "" }
      ],
      output: null,
      occurredAtUnixMs: 1
    },
    ...overrides
  };
}

function renderDeck(
  items: WorkspaceAgentMessageCenterItem[],
  props: Partial<
    React.ComponentProps<typeof WorkspaceAgentMessageCenterAttentionDeck>
  > = {}
) {
  return render(
    <TooltipProvider>
      <WorkspaceAgentMessageCenterAttentionDeck
        items={items}
        isPromptSubmitting={() => false}
        onSubmitPrompt={vi.fn()}
        onOpenChat={vi.fn()}
        {...props}
      />
    </TooltipProvider>
  );
}

describe("WorkspaceAgentMessageCenterAttentionDeck", () => {
  it("renders nothing when there are no items", () => {
    const { container } = renderDeck([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("puts the first (newest) item on top and only the top card is interactive", () => {
    renderDeck([
      promptItem({ agentSessionId: "newest" }),
      promptItem({ agentSessionId: "older" })
    ]);

    const deck = screen.getByTestId(
      "workspace-agent-message-center-attention-deck"
    );
    expect(deck).toHaveAttribute(
      "data-deck-top-item-id",
      "message-center-newest"
    );
    expect(deck).toHaveAttribute("data-deck-count", "2");
    // exactly one interactive prompt surface (one "Yes, proceed" button)
    expect(
      screen.getAllByRole("button", { name: "Yes, proceed" })
    ).toHaveLength(1);
  });

  it("renders stacked peek edges instead of behind cards or a text indicator", () => {
    renderDeck([
      promptItem({ agentSessionId: "a" }),
      promptItem({ agentSessionId: "b" }),
      promptItem({ agentSessionId: "c" })
    ]);
    const deck = screen.getByTestId(
      "workspace-agent-message-center-attention-deck"
    );
    expect(deck).toHaveAttribute("data-deck-peek-count", "2");
    expect(screen.queryByText(/more waiting below/)).toBeNull();
    // Cards behind the top are represented by peek edges, not rendered cards.
    expect(screen.queryByText("b")).toBeNull();
    expect(screen.queryByText("c")).toBeNull();
  });

  it("shows a single peek edge when one card waits behind", () => {
    renderDeck([
      promptItem({ agentSessionId: "a" }),
      promptItem({ agentSessionId: "b" })
    ]);
    expect(
      screen.getByTestId("workspace-agent-message-center-attention-deck")
    ).toHaveAttribute("data-deck-peek-count", "1");
  });

  it("caps the peek edges at two even with more cards behind", () => {
    renderDeck([
      promptItem({ agentSessionId: "a" }),
      promptItem({ agentSessionId: "b" }),
      promptItem({ agentSessionId: "c" }),
      promptItem({ agentSessionId: "d" })
    ]);
    expect(
      screen.getByTestId("workspace-agent-message-center-attention-deck")
    ).toHaveAttribute("data-deck-peek-count", "2");
  });

  it("shows no peek edge when only one card is present", () => {
    renderDeck([promptItem({ agentSessionId: "solo" })]);
    expect(
      screen.getByTestId("workspace-agent-message-center-attention-deck")
    ).toHaveAttribute("data-deck-peek-count", "0");
  });

  it("promotes a highlighted non-top item to the top slot", () => {
    renderDeck(
      [
        promptItem({ agentSessionId: "newest" }),
        promptItem({ agentSessionId: "older" })
      ],
      { highlightedItemId: "message-center-older" }
    );
    const deck = screen.getByTestId(
      "workspace-agent-message-center-attention-deck"
    );
    expect(deck).toHaveAttribute(
      "data-deck-top-item-id",
      "message-center-older"
    );
  });
});

describe("WorkspaceAgentMessageCenterAttentionDeck cooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("does not disable the top option on first mount", () => {
    render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterAttentionDeck
          items={[promptItem({ agentSessionId: "first" })]}
          isPromptSubmitting={() => false}
          onSubmitPrompt={vi.fn()}
          onOpenChat={vi.fn()}
        />
      </TooltipProvider>
    );
    expect(
      screen.getByRole("button", { name: "Yes, proceed" })
    ).not.toBeDisabled();
  });

  it("disables the new top for the cooldown window, then re-enables it", () => {
    const { rerender } = render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterAttentionDeck
          items={[promptItem({ agentSessionId: "first" })]}
          isPromptSubmitting={() => false}
          onSubmitPrompt={vi.fn()}
          onOpenChat={vi.fn()}
        />
      </TooltipProvider>
    );

    // A new card jumps to the top.
    rerender(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterAttentionDeck
          items={[
            promptItem({ agentSessionId: "second" }),
            promptItem({ agentSessionId: "first" })
          ]}
          isPromptSubmitting={() => false}
          onSubmitPrompt={vi.fn()}
          onOpenChat={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(
      screen.getAllByRole("button", { name: "Yes, proceed" })[0]
    ).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(
      screen.getAllByRole("button", { name: "Yes, proceed" })[0]
    ).not.toBeDisabled();
  });
});

describe("WorkspaceAgentMessageCenterAttentionDeck transitions", () => {
  it("keeps a leaving ghost of the answered top card until its animation ends", () => {
    const { rerender, container } = render(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterAttentionDeck
          items={[
            promptItem({ agentSessionId: "top" }),
            promptItem({ agentSessionId: "next" })
          ]}
          isPromptSubmitting={() => false}
          onSubmitPrompt={vi.fn()}
          onOpenChat={vi.fn()}
        />
      </TooltipProvider>
    );

    // The top card is answered and removed from the model.
    rerender(
      <TooltipProvider>
        <WorkspaceAgentMessageCenterAttentionDeck
          items={[promptItem({ agentSessionId: "next" })]}
          isPromptSubmitting={() => false}
          onSubmitPrompt={vi.fn()}
          onOpenChat={vi.fn()}
        />
      </TooltipProvider>
    );

    const ghost = container.querySelector(
      '[data-deck-leaving-item-id="message-center-top"]'
    );
    expect(ghost).not.toBeNull();

    // Fire the animation end -> ghost is dropped.
    fireEvent.animationEnd(ghost as Element);
    expect(
      container.querySelector(
        '[data-deck-leaving-item-id="message-center-top"]'
      )
    ).toBeNull();
  });
});
