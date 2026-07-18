import { act, renderHook } from "@testing-library/react";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUINodeData, AgentGUIAgentTarget } from "../../../types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import { useAgentGUIProviderHome } from "./useAgentGUIProviderHome";

describe("useAgentGUIProviderHome", () => {
  it("restores the selected target's last session in the current node", () => {
    const codexTarget = target("codex", "agent:codex", "provider-target:codex");
    const claudeTarget = target(
      "claude-code",
      "agent:claude-code",
      "provider-target:claude-code"
    );
    const conversations = [
      conversation("codex-session", "codex", "agent:codex"),
      conversation("claude-session", "claude-code", "agent:claude-code")
    ];
    let data: AgentGUINodeData = {
      agentTargetId: "agent:codex",
      lastActiveAgentSessionId: "codex-session",
      lastActiveAgentSessionIdByAgentTargetId: {
        "agent:claude-code": "claude-session",
        "agent:codex": "codex-session"
      },
      provider: "codex"
    };
    const dataRef = { current: data };
    const activeConversationIdRef = {
      current: "codex-session" as string | null
    };
    const selectConversation = vi.fn();
    const unactivate = vi.fn().mockResolvedValue(undefined);
    const setConversationFilter = vi.fn();
    const { result } = renderHook(() =>
      useAgentGUIProviderHome({
        activeConversationId: activeConversationIdRef.current,
        activeConversationIdRef,
        activePendingActivation: null,
        agentActivityRuntime: {} as never,
        agentTargetsLoading: false,
        clearRailRevealRequest: vi.fn(),
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: "agent:codex"
        },
        conversationFilterRef: {
          current: {
            kind: "agentTarget",
            agentTargetId: "agent:codex"
          }
        },
        conversationListInitialized: true,
        conversations,
        conversationsRef: { current: conversations },
        data,
        dataRef,
        defaultAgentTargetId: "agent:codex",
        effectiveSelectedProviderTarget: codexTarget,
        firstReadyHomeComposerProviderTarget: codexTarget,
        homeComposerTargetOverride: null,
        isComposerHomeRef: { current: false },
        isLoadingConversations: false,
        normalizedExplicitProviderTargets: [codexTarget, claudeTarget],
        normalizedProviderTargets: [codexTarget, claudeTarget],
        onDataChangeRef: {
          current: (updater) => {
            data = updater(data);
            dataRef.current = data;
          }
        },
        persistActiveConversation: vi.fn(),
        previewMode: false,
        providerReadinessGates: null,
        selectedComposerTargetDataRef: {
          current: {
            agentTargetId: "agent:codex",
            data,
            provider: "codex",
            targetId: "provider-target:codex"
          }
        },
        selectConversation,
        sessionEngine: engine(conversations),
        setActiveConversationId: vi.fn(),
        setConversationFilter,
        setDetailError: vi.fn(),
        setHomeComposerTargetOverride: vi.fn(),
        setIntent: vi.fn(),
        setIsComposerHome: vi.fn(),
        setIsLoadingMessages: vi.fn(),
        shouldUseStaticProviderTargets: false,
        transientConversation: null,
        unactivate,
        workspaceId: "workspace-1"
      })
    );

    act(() =>
      result.current.selectConversationFilterTarget({
        agentTargetId: "  agent:claude-code  ",
        provider: "claude-code"
      })
    );

    expect(unactivate).toHaveBeenCalledWith("codex-session");
    expect(setConversationFilter).toHaveBeenCalledWith({
      kind: "agentTarget",
      agentTargetId: "agent:claude-code"
    });
    expect(selectConversation).toHaveBeenCalledWith("claude-session", {
      reloadConversations: false
    });
    expect(data.lastActiveAgentSessionIdByAgentTargetId).toEqual({
      "agent:claude-code": "claude-session",
      "agent:codex": "codex-session"
    });
    const filterCallCount = setConversationFilter.mock.calls.length;
    const selectionCallCount = selectConversation.mock.calls.length;
    const unactivateCallCount = unactivate.mock.calls.length;

    act(() =>
      result.current.selectConversationFilterTarget({
        agentTargetId: "   ",
        provider: "claude-code"
      })
    );

    expect(setConversationFilter).toHaveBeenCalledTimes(filterCallCount);
    expect(selectConversation).toHaveBeenCalledTimes(selectionCallCount);
    expect(unactivate).toHaveBeenCalledTimes(unactivateCallCount);
  });
});

function target(
  provider: string,
  agentTargetId: string,
  targetId: string
): AgentGUIAgentTarget {
  return {
    agentTargetId,
    label: agentTargetId,
    provider,
    ref: { kind: "local", provider },
    targetId
  };
}

function conversation(
  id: string,
  provider: string,
  agentTargetId: string
): AgentGUIConversationSummary {
  return {
    agentTargetId,
    cwd: "/repo",
    id,
    provider,
    status: "completed",
    title: id,
    updatedAtUnixMs: 1
  };
}

function engine(
  conversations: readonly AgentGUIConversationSummary[]
): AgentSessionEngine {
  return {
    getSnapshot: () => ({
      sessionLifecycle: {
        deletedSessionIds: {},
        sessionsById: Object.fromEntries(
          conversations.map((item) => [
            item.id,
            {
              agentSessionId: item.id,
              agentTargetId: item.agentTargetId
            }
          ])
        )
      }
    })
  } as unknown as AgentSessionEngine;
}
