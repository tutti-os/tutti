import { renderHook } from "@testing-library/react";
import {
  normalizeAgentActivitySession,
  type CanonicalAgentSession
} from "@tutti-os/agent-activity-core";
import { describe, expect, it } from "vitest";
import { useAgentGUIComposerCapabilities } from "./useAgentGUIComposerCapabilities";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";

describe("useAgentGUIComposerCapabilities", () => {
  function engineSession(input: {
    agentSessionId?: string;
    usage: CanonicalAgentSession["usage"];
  }): CanonicalAgentSession {
    const normalized = normalizeAgentActivitySession({
      ...{
        activeTurnId: null,
        latestTurnInteractions: [],
        pendingInteractions: []
      },
      workspaceId: "workspace-1",
      agentSessionId: input.agentSessionId ?? "session-1",
      provider: "opencode",
      providerSessionId: "provider-session-1",
      cwd: "/workspace/project",
      title: "OpenCode",
      usage: input.usage
    });
    const {
      activeTurn: _activeTurn,
      latestTurn: _latestTurn,
      latestTurnInteractions: _latestTurnInteractions,
      pendingInteractions: _pendingInteractions,
      ...activeEngineSession
    } = normalized;
    return activeEngineSession as CanonicalAgentSession;
  }

  it("projects typed canonical session usage into the composer footer", () => {
    const activeEngineSession = engineSession({
      usage: {
        contextWindow: { usedTokens: 33_168, totalTokens: 400_000 },
        quotas: []
      }
    });
    const data = {
      provider: "opencode" as const,
      agentTargetId: "local:opencode",
      lastActiveAgentSessionId: "session-1"
    };

    const { result, rerender } = renderHook(() =>
      useAgentGUIComposerCapabilities({
        activeConversationId: "session-1",
        activeEngineSession,
        activeSessionState: null,
        data,
        draftSettingsBySessionId: {},
        selectedComposerTargetData: {
          agentTargetId: "local:opencode",
          data,
          provider: "opencode",
          targetId: "local:opencode"
        },
        sessionEngine: createTestAgentSessionEngine("workspace-1")
      })
    );

    expect(result.current.usage).toEqual({
      usedTokens: 33_168,
      totalTokens: 400_000,
      percentUsed: 8,
      quotas: []
    });
    const previousUsage = result.current.usage;

    rerender();

    expect(result.current.usage).toBe(previousUsage);
  });

  it("retains the last session usage while a model change awaits fresh usage", () => {
    let activeEngineSession = engineSession({
      usage: {
        contextWindow: { usedTokens: 20_000, totalTokens: 200_000 },
        quotas: []
      }
    });
    const data = {
      provider: "opencode" as const,
      agentTargetId: "local:opencode",
      lastActiveAgentSessionId: "session-1"
    };
    const { result, rerender } = renderHook(() =>
      useAgentGUIComposerCapabilities({
        activeConversationId: activeEngineSession.agentSessionId,
        activeEngineSession,
        activeSessionState: null,
        data,
        draftSettingsBySessionId: {},
        selectedComposerTargetData: {
          agentTargetId: "local:opencode",
          data,
          provider: "opencode",
          targetId: "local:opencode"
        },
        sessionEngine: createTestAgentSessionEngine("workspace-1")
      })
    );

    const previousUsage = result.current.usage;
    activeEngineSession = engineSession({ usage: null });
    rerender();

    expect(result.current.usage).toBe(previousUsage);

    activeEngineSession = engineSession({
      usage: {
        contextWindow: { usedTokens: 36_103, totalTokens: 1_000_000 },
        quotas: []
      }
    });
    rerender();

    expect(result.current.usage).toEqual({
      usedTokens: 36_103,
      totalTokens: 1_000_000,
      percentUsed: 4,
      quotas: []
    });
  });

  it("does not carry retained usage into another session", () => {
    let activeEngineSession = engineSession({
      usage: {
        contextWindow: { usedTokens: 20_000, totalTokens: 200_000 },
        quotas: []
      }
    });
    const data = {
      provider: "opencode" as const,
      agentTargetId: "local:opencode",
      lastActiveAgentSessionId: "session-1"
    };
    const { result, rerender } = renderHook(() =>
      useAgentGUIComposerCapabilities({
        activeConversationId: activeEngineSession.agentSessionId,
        activeEngineSession,
        activeSessionState: null,
        data,
        draftSettingsBySessionId: {},
        selectedComposerTargetData: {
          agentTargetId: "local:opencode",
          data,
          provider: "opencode",
          targetId: "local:opencode"
        },
        sessionEngine: createTestAgentSessionEngine("workspace-1")
      })
    );

    expect(result.current.usage?.totalTokens).toBe(200_000);

    activeEngineSession = engineSession({
      agentSessionId: "session-2",
      usage: null
    });
    rerender();

    expect(result.current.usage).toBeNull();
  });
});
