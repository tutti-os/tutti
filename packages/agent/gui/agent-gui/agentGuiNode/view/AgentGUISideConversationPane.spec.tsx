// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentGUISideConversationPane } from "./AgentGUISideConversationPane";

vi.mock("../AgentComposer", () => ({
  AgentComposer: () => <input aria-label="Side composer" />
}));

vi.mock("./AgentGUIConversationTimelinePane", () => ({
  AgentGUIConversationTimelinePane: ({ isLoading }: { isLoading: boolean }) => (
    <div data-testid="side-timeline-state">
      {isLoading ? "loading" : "ready"}
    </div>
  )
}));

describe("AgentGUISideConversationPane", () => {
  it("contains an asynchronous close failure at the inline presentation boundary", async () => {
    const onClose = vi.fn(async () => {
      throw new Error("daemon unavailable");
    });
    render(
      <AgentGUISideConversationPane
        active={
          {
            status: "idle",
            activeTurnId: null,
            conversation: null,
            error: null
          } as never
        }
        availableSkills={[]}
        composerProps={{} as never}
        conversationFlowLabels={{
          thinkingLabel: "Thinking",
          toolCallsLabel: (count) => `${count}`,
          processing: "Processing",
          turnSummary: "Summary",
          userMessageLocator: "User"
        }}
        isVisible
        loadingLabel="Loading"
        workspaceAppIcons={[]}
        onClose={onClose}
        onFocusChange={vi.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Side conversation" })
    );
    await Promise.resolve();

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the timeline loading state while Side is opening", () => {
    render(
      <AgentGUISideConversationPane
        active={
          {
            status: "opening",
            activeTurnId: null,
            conversation: null,
            error: null
          } as never
        }
        availableSkills={[]}
        composerProps={{} as never}
        conversationFlowLabels={{
          thinkingLabel: "Thinking",
          toolCallsLabel: (count) => `${count}`,
          processing: "Processing",
          turnSummary: "Summary",
          userMessageLocator: "User"
        }}
        isVisible
        loadingLabel="Loading Side"
        workspaceAppIcons={[]}
        onClose={vi.fn()}
        onFocusChange={vi.fn()}
      />
    );

    expect(screen.getByTestId("side-timeline-state")).toHaveTextContent(
      "loading"
    );
  });

  it("releases Side focus when the pane hides or unmounts", () => {
    const onFocusChange = vi.fn();
    const rendered = render(
      <AgentGUISideConversationPane
        active={
          {
            status: "idle",
            activeTurnId: null,
            conversation: null,
            error: null
          } as never
        }
        availableSkills={[]}
        composerProps={{} as never}
        conversationFlowLabels={{
          thinkingLabel: "Thinking",
          toolCallsLabel: (count) => `${count}`,
          processing: "Processing",
          turnSummary: "Summary",
          userMessageLocator: "User"
        }}
        isVisible
        loadingLabel="Loading"
        workspaceAppIcons={[]}
        onClose={vi.fn()}
        onFocusChange={onFocusChange}
      />
    );

    fireEvent.focus(screen.getByRole("textbox", { name: "Side composer" }));
    expect(onFocusChange).toHaveBeenCalledWith(true);

    rendered.rerender(
      <AgentGUISideConversationPane
        active={
          {
            status: "idle",
            activeTurnId: null,
            conversation: null,
            error: null
          } as never
        }
        availableSkills={[]}
        composerProps={{} as never}
        conversationFlowLabels={{
          thinkingLabel: "Thinking",
          toolCallsLabel: (count) => `${count}`,
          processing: "Processing",
          turnSummary: "Summary",
          userMessageLocator: "User"
        }}
        isVisible={false}
        loadingLabel="Loading"
        workspaceAppIcons={[]}
        onClose={vi.fn()}
        onFocusChange={onFocusChange}
      />
    );
    expect(onFocusChange).toHaveBeenLastCalledWith(false);

    rendered.unmount();
    expect(onFocusChange).toHaveBeenLastCalledWith(false);
  });
});
