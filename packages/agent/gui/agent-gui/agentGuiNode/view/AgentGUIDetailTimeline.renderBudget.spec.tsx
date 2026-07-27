import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentGUIDetailTimeline } from "./AgentGUIDetailTimeline";

const { timelineRenderSpy } = vi.hoisted(() => ({
  timelineRenderSpy: vi.fn()
}));

vi.mock("./AgentGUIConversationTimelinePane", () => ({
  AgentGUIConversationTimelinePane: (props: unknown) => {
    timelineRenderSpy(props);
    return <div data-testid="conversation-timeline" />;
  }
}));

describe("AgentGUIDetailTimeline render budget", () => {
  it("does not rerender the active timeline for a parent-only draft update", () => {
    const stableProps = {
      availableSkills: [],
      conversation: null,
      conversationFlowEmpty: <div />,
      conversationFlowLabels: {
        thinkingLabel: "Thinking",
        toolCallsLabel: (count: number) => `${count}`,
        processing: "Processing",
        turnSummary: "Summary",
        userMessageLocator: "User"
      },
      hasActiveConversation: true,
      homeContent: null,
      isLoadingOlderMessages: false,
      isTimelineScrolledToTop: true,
      labels: { loadingConversation: "Loading" },
      previewMode: false,
      showTimelineSkeleton: false,
      showUnavailableChatEmpty: false,
      timelineContentRef: createRef<HTMLDivElement>(),
      timelineRef: createRef<HTMLDivElement>(),
      workspaceAppIcons: []
    };
    const Parent = ({ draft }: { draft: string }) => {
      void draft;
      return <AgentGUIDetailTimeline {...stableProps} />;
    };
    const rendered = render(<Parent draft="" />);
    expect(timelineRenderSpy).toHaveBeenCalledOnce();

    rendered.rerender(<Parent draft="a" />);

    expect(timelineRenderSpy).toHaveBeenCalledOnce();
  });
});
