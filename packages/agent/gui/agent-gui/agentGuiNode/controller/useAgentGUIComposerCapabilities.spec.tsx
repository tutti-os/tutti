import { renderHook } from "@testing-library/react";
import {
  createEmptyAgentActivitySnapshot,
  normalizeAgentActivitySession,
  type CanonicalAgentSession
} from "@tutti-os/agent-activity-core";
import { describe, expect, it } from "vitest";
import { useAgentGUIComposerCapabilities } from "./useAgentGUIComposerCapabilities";

describe("useAgentGUIComposerCapabilities", () => {
  it("projects typed canonical session usage into the composer footer", () => {
    const normalized = normalizeAgentActivitySession({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      provider: "opencode",
      providerSessionId: "provider-session-1",
      cwd: "/workspace/project",
      title: "OpenCode",
      usage: {
        contextWindow: { usedTokens: 33_168, totalTokens: 400_000 },
        quotas: []
      }
    });
    const {
      activeTurn: _activeTurn,
      latestTurn: _latestTurn,
      latestTurnInteractions: _latestTurnInteractions,
      pendingInteractions: _pendingInteractions,
      ...activeEngineSession
    } = normalized;
    const data = {
      provider: "opencode" as const,
      agentTargetId: "local:opencode",
      lastActiveAgentSessionId: "session-1"
    };

    const { result } = renderHook(() =>
      useAgentGUIComposerCapabilities({
        activeConversationId: "session-1",
        activeEngineSession: activeEngineSession as CanonicalAgentSession,
        activeSessionState: null,
        agentActivitySnapshot: createEmptyAgentActivitySnapshot("workspace-1"),
        data,
        draftSettingsBySessionId: {},
        selectedComposerTargetData: {
          agentTargetId: "local:opencode",
          data,
          provider: "opencode",
          targetId: "local:opencode"
        }
      })
    );

    expect(result.current.usage).toEqual({
      usedTokens: 33_168,
      totalTokens: 400_000,
      percentUsed: 8,
      quotas: []
    });
  });
});
