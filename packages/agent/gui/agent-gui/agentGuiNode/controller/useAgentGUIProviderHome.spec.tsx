import { act, renderHook } from "@testing-library/react";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUINodeData, AgentGUIAgentTarget } from "../../../types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import { useAgentGUIProviderHome } from "./useAgentGUIProviderHome";

describe("useAgentGUIProviderHome", () => {
  it("restores the selected target's last session in the current node", () => {
    const codexTarget = target("codex", "local:codex");
    const claudeTarget = target("claude-code", "local:claude-code");
    const conversations = [
      conversation("codex-session", "codex", "local:codex"),
      conversation("claude-session", "claude-code", "local:claude-code")
    ];
    let data: AgentGUINodeData = {
      agentTargetId: "local:codex",
      lastActiveAgentSessionId: "codex-session",
      lastActiveAgentSessionIdByAgentTargetId: {
        "local:claude-code": "claude-session",
        "local:codex": "codex-session"
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
          agentTargetId: "local:codex"
        },
        conversationFilterRef: {
          current: {
            kind: "agentTarget",
            agentTargetId: "local:codex"
          }
        },
        conversationListInitialized: true,
        conversations,
        conversationsRef: { current: conversations },
        data,
        dataRef,
        defaultAgentTargetId: "local:codex",
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
            agentTargetId: "local:codex",
            data,
            provider: "codex",
            targetId: "local:codex"
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
        agentTargetId: "local:claude-code",
        provider: "claude-code"
      })
    );

    expect(unactivate).toHaveBeenCalledWith("codex-session");
    expect(setConversationFilter).toHaveBeenCalledWith({
      kind: "agentTarget",
      agentTargetId: "local:claude-code"
    });
    expect(selectConversation).toHaveBeenCalledWith("claude-session", {
      reloadConversations: false
    });
    expect(data.lastActiveAgentSessionIdByAgentTargetId).toEqual({
      "local:claude-code": "claude-session",
      "local:codex": "codex-session"
    });
  });
});

function target(provider: string, agentTargetId: string): AgentGUIAgentTarget {
  return {
    agentTargetId,
    label: agentTargetId,
    provider,
    ref: { kind: "local", provider },
    targetId: agentTargetId
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
