import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import { useAgentGUIConversationPresentation } from "./useAgentGUIConversationPresentation";

type PresentationInput = Parameters<
  typeof useAgentGUIConversationPresentation
>[0];

describe("useAgentGUIConversationPresentation", () => {
  it("does not project the provider name as a fallback conversation title", () => {
    const conversation = createConversation();
    const input = createInput(conversation);
    const rendered = renderHook(() =>
      useAgentGUIConversationPresentation({
        ...input,
        conversations: []
      })
    );

    expect(rendered.result.current.activeConversation).toEqual(
      expect.objectContaining({
        provider: "codex",
        title: "",
        titleFallback: "untitled-conversation"
      })
    );
  });

  it("reuses visible and active conversation references for render-equal input", () => {
    const conversation = createConversation();
    const input = createInput(conversation);
    const rendered = renderHook(
      ({ value }: { value: PresentationInput }) =>
        useAgentGUIConversationPresentation(value),
      { initialProps: { value: input } }
    );
    const previous = rendered.result.current;

    rendered.rerender({
      value: {
        ...input,
        activityDisplayStatuses: new Map(),
        conversations: [{ ...conversation }]
      }
    });

    expect(rendered.result.current.visibleConversations).toBe(
      previous.visibleConversations
    );
    expect(rendered.result.current.activeConversation).toBe(
      previous.activeConversation
    );
  });

  it("updates active semantic metadata without invalidating the rail list", () => {
    const conversation = createConversation();
    const input = createInput(conversation);
    const rendered = renderHook(
      ({ value }: { value: PresentationInput }) =>
        useAgentGUIConversationPresentation(value),
      { initialProps: { value: input } }
    );
    const previous = rendered.result.current;

    rendered.rerender({
      value: {
        ...input,
        conversations: [{ ...conversation, resumable: false }]
      }
    });

    expect(rendered.result.current.visibleConversations).toBe(
      previous.visibleConversations
    );
    expect(rendered.result.current.activeConversation).not.toBe(
      previous.activeConversation
    );
    expect(rendered.result.current.activeConversation?.resumable).toBe(false);
  });
});

function createInput(
  conversation: AgentGUIConversationSummary
): PresentationInput {
  const data = {
    lastActiveAgentSessionId: conversation.id,
    provider: conversation.provider
  };
  return {
    activeConversationId: conversation.id,
    activeLatestPendingSubmitTurnId: null,
    activityDisplayStatuses: new Map(),
    agentTargetsLoading: false,
    conversations: [conversation],
    currentUserId: "user-1",
    data,
    dataRef: { current: data },
    defaultAgentTargetId: null,
    draftByScopeKey: {},
    hasUnconfirmedSubmit: false,
    isCreatingConversation: false,
    isSubmitting: true,
    normalizedExplicitProviderTargets: [],
    normalizedProviderTargets: [],
    onDataChangeRef: { current: vi.fn() },
    previewMode: true,
    shouldUseStaticProviderTargets: false,
    transientConversation: null,
    userProjects: [],
    workspacePath: "/workspace"
  };
}

function createConversation(): AgentGUIConversationSummary {
  return {
    agentTargetId: "target-1",
    cwd: "/workspace",
    id: "session-1",
    provider: "codex",
    status: "ready",
    title: "streaming session",
    titleFallback: null,
    updatedAtUnixMs: 1,
    userId: "user-1"
  };
}
