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
    const fixture = renderProviderHome({
      activeConversationId: "codex-session",
      conversations,
      data: {
        agentTargetId: "agent:codex",
        lastActiveAgentSessionId: "codex-session",
        lastActiveAgentSessionIdByAgentTargetId: {
          "agent:claude-code": "claude-session",
          "agent:codex": "codex-session"
        },
        provider: "codex"
      },
      selectedTarget: codexTarget,
      targets: [codexTarget, claudeTarget]
    });

    act(() =>
      fixture.result.current.selectConversationFilterTarget({
        agentTargetId: "  agent:claude-code  ",
        provider: "claude-code"
      })
    );

    expect(fixture.unactivate).toHaveBeenCalledWith("codex-session");
    expect(fixture.setConversationFilter).toHaveBeenCalledWith({
      kind: "agentTarget",
      agentTargetId: "agent:claude-code"
    });
    expect(fixture.selectConversation).toHaveBeenCalledWith("claude-session", {
      reloadConversations: false
    });
    expect(fixture.getData().lastActiveAgentSessionIdByAgentTargetId).toEqual({
      "agent:claude-code": "claude-session",
      "agent:codex": "codex-session"
    });
    const filterCallCount = fixture.setConversationFilter.mock.calls.length;
    const selectionCallCount = fixture.selectConversation.mock.calls.length;
    const unactivateCallCount = fixture.unactivate.mock.calls.length;

    act(() =>
      fixture.result.current.selectConversationFilterTarget({
        agentTargetId: "   ",
        provider: "claude-code"
      })
    );

    expect(fixture.setConversationFilter).toHaveBeenCalledTimes(
      filterCallCount
    );
    expect(fixture.selectConversation).toHaveBeenCalledTimes(
      selectionCallCount
    );
    expect(fixture.unactivate).toHaveBeenCalledTimes(unactivateCallCount);
  });

  it("keeps a restored active session when the bounded rail page is empty", () => {
    const codexTarget = target("codex", "agent:codex", "provider-target:codex");
    const fixture = renderProviderHome({
      activeConversationId: "persisted-session",
      conversations: [],
      data: {
        agentTargetId: "agent:codex",
        lastActiveAgentSessionId: "persisted-session",
        provider: "codex"
      },
      selectedTarget: codexTarget,
      targets: [codexTarget]
    });

    expect(fixture.unactivate).not.toHaveBeenCalled();
    expect(fixture.setActiveConversationId).not.toHaveBeenCalled();
    expect(fixture.persistActiveConversation).not.toHaveBeenCalled();
    expect(fixture.onDataChange).not.toHaveBeenCalled();
    expect(fixture.getData().lastActiveAgentSessionId).toBe(
      "persisted-session"
    );
  });
});

function renderProviderHome(input: {
  activeConversationId: string | null;
  conversations: readonly AgentGUIConversationSummary[];
  data: AgentGUINodeData;
  selectedTarget: AgentGUIAgentTarget;
  targets: readonly AgentGUIAgentTarget[];
}) {
  let data = input.data;
  const dataRef = { current: data };
  const activeConversationIdRef = {
    current: input.activeConversationId
  };
  const selectConversation = vi.fn();
  const unactivate = vi.fn().mockResolvedValue(undefined);
  const setConversationFilter = vi.fn();
  const setActiveConversationId = vi.fn();
  const persistActiveConversation = vi.fn();
  const onDataChange = vi.fn(
    (updater: (current: AgentGUINodeData) => AgentGUINodeData) => {
      data = updater(data);
      dataRef.current = data;
    }
  );
  const agentTargetId = input.selectedTarget.agentTargetId!;
  const { result } = renderHook(() =>
    useAgentGUIProviderHome({
      activeConversationId: activeConversationIdRef.current,
      activeConversationIdRef,
      activePendingActivation: null,
      agentActivityRuntime: {} as never,
      clearRailRevealRequest: vi.fn(),
      conversationFilter: { kind: "agentTarget", agentTargetId },
      conversationFilterRef: {
        current: { kind: "agentTarget", agentTargetId }
      },
      conversationsRef: { current: input.conversations },
      data,
      dataRef,
      defaultAgentTargetId: agentTargetId,
      effectiveSelectedProviderTarget: input.selectedTarget,
      firstReadyHomeComposerProviderTarget: input.selectedTarget,
      homeComposerTargetOverride: null,
      isComposerHomeRef: { current: false },
      isLoadingConversations: false,
      normalizedExplicitProviderTargets: input.targets,
      normalizedProviderTargets: input.targets,
      onDataChangeRef: { current: onDataChange },
      persistActiveConversation,
      previewMode: false,
      providerReadinessGates: null,
      selectedComposerTargetDataRef: {
        current: {
          agentTargetId,
          data,
          provider: input.selectedTarget.provider,
          targetId: input.selectedTarget.targetId
        }
      },
      selectConversation,
      sessionEngine: engine(input.conversations),
      setActiveConversationId,
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
  return {
    getData: () => data,
    onDataChange,
    persistActiveConversation,
    result,
    selectConversation,
    setActiveConversationId,
    setConversationFilter,
    unactivate
  };
}

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
