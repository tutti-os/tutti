import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import {
  AGENT_GUI_TIMELINE_SKELETON_DELAY_MS,
  useAgentGUITimelineTransition
} from "./useAgentGUITimelineTransition";

afterEach(() => {
  vi.useRealTimers();
});

describe("useAgentGUITimelineTransition", () => {
  it("keeps the previous timeline without flashing a skeleton for a fast load", () => {
    vi.useFakeTimers();
    const conversationA = conversation("conversation-a");
    const conversationB = conversation("conversation-b");
    const { result, rerender } = renderHook(
      (input: TimelineTransitionInput) => useAgentGUITimelineTransition(input),
      {
        initialProps: {
          activeConversationId: "conversation-a",
          availability: "ready",
          conversation: conversationA
        } as TimelineTransitionInput
      }
    );

    rerender({
      activeConversationId: "conversation-b",
      availability: "loading",
      conversation: null
    });
    expect(result.current.conversation).toBe(conversationA);
    expect(result.current.showTimelineSkeleton).toBe(false);
    expect(result.current.timelineConversationId).toBe("conversation-a");

    act(() => {
      vi.advanceTimersByTime(AGENT_GUI_TIMELINE_SKELETON_DELAY_MS - 1);
    });
    rerender({
      activeConversationId: "conversation-b",
      availability: "ready",
      conversation: conversationB
    });

    expect(result.current.conversation).toBe(conversationB);
    expect(result.current.showTimelineSkeleton).toBe(false);
    expect(result.current.timelineConversationId).toBe("conversation-b");
  });

  it("reveals the conversation skeleton after 300ms", () => {
    vi.useFakeTimers();
    const conversationA = conversation("conversation-a");
    const { result, rerender } = renderHook(
      (input: TimelineTransitionInput) => useAgentGUITimelineTransition(input),
      {
        initialProps: {
          activeConversationId: "conversation-a",
          availability: "ready",
          conversation: conversationA
        } as TimelineTransitionInput
      }
    );

    rerender({
      activeConversationId: "conversation-b",
      availability: "loading",
      conversation: null
    });
    act(() => {
      vi.advanceTimersByTime(AGENT_GUI_TIMELINE_SKELETON_DELAY_MS);
    });

    expect(result.current.showTimelineSkeleton).toBe(true);
    expect(result.current.timelineConversationId).toBe("conversation-b");
  });

  it("does not reveal a stale skeleton after a rapid second selection", () => {
    vi.useFakeTimers();
    const conversationA = conversation("conversation-a");
    const { result, rerender } = renderHook(
      (input: TimelineTransitionInput) => useAgentGUITimelineTransition(input),
      {
        initialProps: {
          activeConversationId: "conversation-a",
          availability: "ready",
          conversation: conversationA
        } as TimelineTransitionInput
      }
    );

    rerender({
      activeConversationId: "conversation-b",
      availability: "loading",
      conversation: null
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({
      activeConversationId: "conversation-c",
      availability: "loading",
      conversation: null
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.showTimelineSkeleton).toBe(false);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.showTimelineSkeleton).toBe(true);
  });
});

function conversation(id: string): AgentConversationVM {
  return {
    id,
    rows: [{ id: `${id}-row`, kind: "processing" }]
  } as unknown as AgentConversationVM;
}

type TimelineTransitionInput = Parameters<
  typeof useAgentGUITimelineTransition
>[0];
