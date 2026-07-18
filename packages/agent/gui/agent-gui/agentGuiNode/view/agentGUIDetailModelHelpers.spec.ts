import { describe, expect, it } from "vitest";
import {
  buildAgentConversationHandoffPrompt,
  handoffProjectPathForConversation,
  shouldShowAgentGUIStopButton
} from "./agentGUIDetailModelHelpers.ts";

describe("buildAgentConversationHandoffPrompt", () => {
  it("delegates the active conversation to the canonical session handoff draft", () => {
    expect(
      buildAgentConversationHandoffPrompt({
        activeConversation: {
          id: "session-1",
          agentTargetId: "local:claude-code",
          provider: "claude-code",
          title: "Session 1",
          titleFallback: null,
          status: "completed",
          cwd: "/workspace/project-a",
          updatedAtUnixMs: 1
        },
        currentUserId: "user-1",
        labels: { untitledConversationTitle: "Untitled conversation" },
        selectedAgentTarget: {
          targetId: "local:claude-code",
          agentTargetId: "local:claude-code",
          label: "Claude Code",
          provider: "claude-code",
          ref: {
            kind: "agent-directory",
            provider: "claude-code",
            agentTargetId: "local:claude-code"
          }
        },
        uiLanguage: "en",
        workspaceId: "room-1"
      })
    ).toBe(
      "[@Session 1](mention://agent-session/session-1?agentTargetId=local%3Aclaude-code&workspaceId=room-1) "
    );
  });
});

describe("shouldShowAgentGUIStopButton", () => {
  const idle = {
    hasPendingApproval: false,
    hasPendingInteractivePrompt: false,
    isAuthBlocked: false,
    isCancelPending: false,
    isConversationBusy: false,
    isCreatingConversation: false,
    isInterrupting: false,
    isSubmitting: false,
    isUnavailable: false
  };

  it("allows immediate stop while a new conversation is still activating", () => {
    expect(
      shouldShowAgentGUIStopButton({
        ...idle,
        isCreatingConversation: true,
        isSubmitting: true
      })
    ).toBe(true);
  });

  it("keeps ordinary submission races hidden when there is no stoppable work", () => {
    expect(shouldShowAgentGUIStopButton({ ...idle, isSubmitting: true })).toBe(
      false
    );
  });

  it("keeps authentication and availability gates authoritative", () => {
    expect(
      shouldShowAgentGUIStopButton({
        ...idle,
        isAuthBlocked: true,
        isCreatingConversation: true
      })
    ).toBe(false);
  });
});

describe("handoffProjectPathForConversation", () => {
  it("keeps the canonical project path for the destination session", () => {
    expect(
      handoffProjectPathForConversation({
        cwd: "/workspace/fallback",
        project: { path: " /workspace/project-a " }
      } as never)
    ).toBe("/workspace/project-a");
  });

  it("falls back to the source cwd when project metadata is unavailable", () => {
    expect(
      handoffProjectPathForConversation({
        cwd: " /workspace/project-b ",
        project: null
      } as never)
    ).toBe("/workspace/project-b");
  });
});
