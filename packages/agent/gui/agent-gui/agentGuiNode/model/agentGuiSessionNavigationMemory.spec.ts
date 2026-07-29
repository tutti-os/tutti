import { describe, expect, it } from "vitest";
import type { AgentGUINodeData } from "../../../types";
import {
  forgetAgentGUISessionMemories,
  rememberAgentGUIActiveConversation,
  resolveAgentGUIRememberedSessionSelection,
  resolveAgentGUISessionMemoryTarget
} from "./agentGuiSessionNavigationMemory";

describe("agent GUI session navigation memory", () => {
  it("remembers the last selected session independently for each agent target", () => {
    const initial: AgentGUINodeData = {
      agentTargetId: "local:codex",
      lastActiveAgentSessionId: "codex-1",
      provider: "codex"
    };
    const codex = rememberAgentGUIActiveConversation(
      initial,
      "codex-1",
      "local:codex"
    );
    const claude = rememberAgentGUIActiveConversation(
      codex,
      "claude-1",
      "local:claude-code"
    );
    const home = rememberAgentGUIActiveConversation(claude, null);

    expect(home.lastActiveAgentSessionId).toBeNull();
    expect(home.lastActiveAgentSessionIdByAgentTargetId).toEqual({
      "local:claude-code": "claude-1",
      "local:codex": "codex-1"
    });
  });

  it("forgets deleted sessions without removing other target memories", () => {
    const current: AgentGUINodeData = {
      agentTargetId: "local:claude-code",
      lastActiveAgentSessionId: "claude-1",
      lastActiveAgentSessionIdByAgentTargetId: {
        "local:claude-code": "claude-1",
        "local:codex": "codex-1"
      },
      provider: "claude-code"
    };

    expect(
      forgetAgentGUISessionMemories(current, new Set(["claude-1"]))
    ).toEqual({
      ...current,
      lastActiveAgentSessionId: null,
      lastActiveAgentSessionIdByAgentTargetId: {
        "local:codex": "codex-1"
      }
    });
  });

  it("uses only canonical, projected, or matching pending target evidence", () => {
    expect(
      resolveAgentGUISessionMemoryTarget({
        agentSessionId: "session-1",
        canonicalAgentTargetId: "local:codex",
        pendingActivation: {
          agentSessionId: "session-1",
          agentTargetId: "local:claude-code"
        },
        projectedAgentTargetId: "local:opencode"
      })
    ).toBe("local:codex");
    expect(
      resolveAgentGUISessionMemoryTarget({
        agentSessionId: "session-1",
        pendingActivation: {
          agentSessionId: "session-1",
          agentTargetId: "local:claude-code"
        }
      })
    ).toBe("local:claude-code");
    expect(
      resolveAgentGUISessionMemoryTarget({
        agentSessionId: "session-1",
        pendingActivation: {
          agentSessionId: "other-session",
          agentTargetId: "local:claude-code"
        }
      })
    ).toBeNull();
  });
});

describe("remembered provider session selection", () => {
  const data = {
    lastActiveAgentSessionId: null,
    lastActiveAgentSessionIdByAgentTargetId: {
      "local:codex": "codex-session"
    },
    provider: "codex"
  } as const;

  it("restores the window-local session remembered for the exact target", () => {
    expect(
      resolveAgentGUIRememberedSessionSelection({
        data,
        deleted: false,
        knownAgentTargetId: "local:codex",
        targetAgentTargetId: "local:codex"
      })
    ).toEqual({ agentSessionId: "codex-session", kind: "restore" });
  });

  it("restores a remembered bounded-history session before it is loaded", () => {
    expect(
      resolveAgentGUIRememberedSessionSelection({
        data,
        deleted: false,
        knownAgentTargetId: null,
        targetAgentTargetId: "local:codex"
      })
    ).toEqual({ agentSessionId: "codex-session", kind: "restore" });
  });

  it("rejects deleted or target-mismatched memories", () => {
    expect(
      resolveAgentGUIRememberedSessionSelection({
        data,
        deleted: true,
        knownAgentTargetId: "local:codex",
        targetAgentTargetId: "local:codex"
      })
    ).toEqual({ agentSessionId: "codex-session", kind: "stale" });
    expect(
      resolveAgentGUIRememberedSessionSelection({
        data,
        deleted: false,
        knownAgentTargetId: "local:claude-code",
        targetAgentTargetId: "local:codex"
      })
    ).toEqual({ agentSessionId: "codex-session", kind: "stale" });
  });
});
