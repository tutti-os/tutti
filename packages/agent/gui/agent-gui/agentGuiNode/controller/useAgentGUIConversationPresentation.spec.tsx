import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUINodeData } from "../../../types";
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

  it("preserves the active agent target identity for open-provider fallback conversations", () => {
    const conversation = createConversation();
    const input = createInput({
      ...conversation,
      agentTargetId: "extension:example",
      provider: "acp:example"
    });
    const rendered = renderHook(() =>
      useAgentGUIConversationPresentation({
        ...input,
        conversations: [],
        data: {
          ...input.data,
          agentTargetId: "extension:example",
          provider: "acp:example"
        },
        dataRef: {
          current: {
            ...input.dataRef.current,
            agentTargetId: "extension:example",
            provider: "acp:example"
          }
        },
        normalizedProviderTargets: [
          {
            agentTargetId: "extension:example",
            label: "Example Agent",
            provider: "acp:example",
            ref: {
              kind: "agent_extension",
              provider: "acp:example"
            },
            targetId: "extension:example"
          }
        ]
      })
    );

    expect(rendered.result.current.activeConversation?.title).toBe("");
    expect(rendered.result.current.activeConversation?.titleFallback).toBe(
      "untitled-conversation"
    );
    expect(rendered.result.current.activeConversation?.agentTargetId).toBe(
      "extension:example"
    );
  });

  it("preserves a missing explicit target instead of selecting a provider sibling", () => {
    const conversation = createConversation();
    const input = createInput({
      ...conversation,
      agentTargetId: "extension:missing",
      provider: "acp:example"
    });
    const rendered = renderHook(() =>
      useAgentGUIConversationPresentation({
        ...input,
        conversations: [],
        data: {
          ...input.data,
          agentTargetId: "extension:missing",
          provider: "acp:example"
        },
        dataRef: {
          current: {
            ...input.dataRef.current,
            agentTargetId: "extension:missing",
            provider: "acp:example"
          }
        },
        normalizedProviderTargets: [
          {
            agentTargetId: "extension:sibling",
            label: "Sibling Agent",
            provider: "acp:example",
            ref: {
              kind: "agent_extension",
              provider: "acp:example"
            },
            targetId: "extension:sibling"
          }
        ]
      })
    );

    expect(rendered.result.current.activeConversation?.agentTargetId).toBe(
      "extension:missing"
    );
  });

  it("backfills target memory when canonical session metadata arrives", () => {
    const conversation = createConversation();
    const input = createInput(conversation);
    let data: AgentGUINodeData = input.data;

    input.dataRef = { current: data };
    input.normalizedExplicitProviderTargets = [
      {
        agentTargetId: "target-1",
        label: "Codex",
        provider: "codex",
        ref: { kind: "local", provider: "codex" },
        targetId: "target-1"
      }
    ];
    input.normalizedProviderTargets = input.normalizedExplicitProviderTargets;
    input.onDataChangeRef = {
      current: (updater) => {
        data = updater(data);
        input.dataRef.current = data;
      }
    };

    renderHook(() => useAgentGUIConversationPresentation(input));

    expect(data.lastActiveAgentSessionIdByAgentTargetId).toEqual({
      "target-1": "session-1"
    });
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
