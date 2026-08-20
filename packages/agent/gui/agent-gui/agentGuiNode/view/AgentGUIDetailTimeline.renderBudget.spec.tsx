import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentTranscriptVirtualScrollController } from "../../../shared/agentConversation/components/AgentTranscriptView";
import { AgentGUIDetailTimeline } from "./AgentGUIDetailTimeline";

const { timelineRenderSpy } = vi.hoisted(() => ({
  timelineRenderSpy: vi.fn()
}));

vi.mock("./AgentGUIConversationTimelinePane", () => ({
  AgentGUIConversationTimelinePane: (props: {
    turnAttachments?: readonly { id: string; content: ReactNode }[];
  }) => {
    timelineRenderSpy(props);
    return (
      <div data-testid="conversation-timeline">
        {props.turnAttachments?.map((attachment) => (
          <div key={attachment.id}>{attachment.content}</div>
        ))}
      </div>
    );
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
      followEndMode: "following" as const,
      homeContent: null,
      isLoadingOlderMessages: false,
      isVisible: true,
      isTimelineScrolledToTop: true,
      labels: {
        loadingConversation: "Loading",
        continuedFromTask: "Continued from task",
        selectionAddToConversation: "Add to conversation",
        selectionAskInSide: "Ask in Side chat"
      },
      onAddSelectionToConversation: vi.fn(),
      showTimelineSkeleton: false,
      showUnavailableChatEmpty: false,
      timelineContentRef: createRef<HTMLDivElement>(),
      timelineRef: createRef<HTMLDivElement>(),
      virtualScrollControllerRef:
        createRef<AgentTranscriptVirtualScrollController>(),
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

  it("projects durable fork lineage as a target-Turn attachment", () => {
    const onOpenForkSourceSession = vi.fn();
    render(
      <AgentGUIDetailTimeline
        availableSkills={[]}
        conversation={null}
        conversationFlowEmpty={<div />}
        conversationFlowLabels={{
          thinkingLabel: "Thinking",
          toolCallsLabel: (count) => `${count}`,
          processing: "Processing",
          turnSummary: "Summary",
          userMessageLocator: "User"
        }}
        hasActiveConversation
        followEndMode="following"
        forkedFrom={{
          sourceAgentSessionId: "source-session",
          sourceTurnId: "source-turn",
          targetTurnId: "target-turn",
          operationId: "fork-operation",
          forkedAtUnixMs: 100
        }}
        homeContent={null}
        isLoadingOlderMessages={false}
        isVisible
        isTimelineScrolledToTop
        labels={{
          loadingConversation: "Loading",
          continuedFromTask: "Continued from task",
          selectionAddToConversation: "Add to conversation",
          selectionAskInSide: "Ask in Side chat"
        }}
        onAddSelectionToConversation={vi.fn()}
        onOpenForkSourceSession={onOpenForkSourceSession}
        showTimelineSkeleton={false}
        showUnavailableChatEmpty={false}
        timelineContentRef={createRef<HTMLDivElement>()}
        timelineRef={createRef<HTMLDivElement>()}
        virtualScrollControllerRef={createRef<AgentTranscriptVirtualScrollController>()}
        workspaceAppIcons={[]}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Continued from task" })
    );
    expect(onOpenForkSourceSession).toHaveBeenCalledWith("source-session");
    expect(timelineRenderSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        turnAttachments: [
          expect.objectContaining({
            anchorTurnId: "target-turn",
            id: "fork-lineage:fork-operation",
            missingAnchorBehavior: "hide"
          })
        ]
      })
    );
  });
});
