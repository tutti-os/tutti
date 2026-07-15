import { describe, expect, it } from "vitest";
import type { WorkspaceAgentActivityTimelineItem } from "../../../shared/workspaceAgentTimelineTypes";
import {
  normalizeAgentGUIProviderIdentity,
  resolveAgentGUIConversationDisplayTitle,
  resolveAgentGUIConversationTitle,
  resolveAgentGUIDockConversationTitle,
  resolveAgentGUIExplicitConversationTitle,
  resolveAgentGUIProviderDisplayLabel,
  resolveAgentGUIProviderIdentity
} from "./agentGuiProviderIdentity";

describe("agentGuiProviderIdentity", () => {
  it("normalizes known providers and tutti alias", () => {
    expect(normalizeAgentGUIProviderIdentity("codex")).toBe("codex");
    expect(normalizeAgentGUIProviderIdentity("claude-code")).toBe(
      "claude-code"
    );
    expect(normalizeAgentGUIProviderIdentity("claude")).toBe("claude-code");
    expect(normalizeAgentGUIProviderIdentity("Claude Code")).toBe(
      "claude-code"
    );
    expect(normalizeAgentGUIProviderIdentity("tutti")).toBe("nexight");
    expect(normalizeAgentGUIProviderIdentity("mystery")).toBe("mystery");
  });

  it("prefers authoritative session provider inputs over conversation and timeline hints", () => {
    expect(
      resolveAgentGUIProviderIdentity({
        sessionProvider: "hermes",
        workspaceSessionProvider: "codex",
        conversationProvider: "claude-code",
        timelineItems: [
          timelineItem({
            actorType: "agent",
            actorId: "openclaw",
            role: "assistant",
            itemType: "message.assistant"
          })
        ]
      })
    ).toBe("hermes");
  });

  it("does not infer a provider from a user-only timeline", () => {
    expect(
      resolveAgentGUIProviderIdentity({
        timelineItems: [
          timelineItem({
            actorType: "user",
            actorId: "user-1",
            role: "user",
            itemType: "message.user"
          })
        ]
      })
    ).toBe("unknown");
  });

  it("marks unknown-provider titles for generic-agent fallback instead of translating in the model", () => {
    expect(resolveAgentGUIConversationTitle("", "unknown")).toEqual({
      title: "",
      titleFallback: "generic-agent"
    });
  });

  it("keeps known-provider fallback titles in the model", () => {
    expect(resolveAgentGUIConversationTitle("", "codex")).toEqual({
      title: "Codex",
      titleFallback: null
    });
    expect(resolveAgentGUIConversationTitle("", "claude-code")).toEqual({
      title: "Claude Code",
      titleFallback: null
    });
    expect(resolveAgentGUIConversationTitle("", "hermes")).toEqual({
      title: "Hermes Agent",
      titleFallback: null
    });
    expect(resolveAgentGUIConversationTitle("", "nexight")).toEqual({
      title: "Nexight",
      titleFallback: null
    });
    expect(resolveAgentGUIConversationTitle("", "hermes")).toEqual({
      title: "Hermes Agent",
      titleFallback: null
    });
    expect(resolveAgentGUIConversationTitle("", "openclaw")).toEqual({
      title: "OpenClaw",
      titleFallback: null
    });
  });

  it("preserves punctuation in canonical agent GUI conversation titles", () => {
    expect(
      resolveAgentGUIConversationTitle("Build the landing page.", "codex")
    ).toEqual({
      title: "Build the landing page.",
      titleFallback: null
    });
    expect(
      resolveAgentGUIConversationTitle(
        "开始一个 Claude Code GUI 会话。",
        "claude-code"
      )
    ).toEqual({
      title: "开始一个 Claude Code GUI 会话。",
      titleFallback: null
    });
  });

  it("accepts canonical mention titles", () => {
    expect(
      resolveAgentGUIConversationTitle("@wang jomes & Codex hi", "codex")
    ).toEqual({
      title: "@wang jomes & Codex hi",
      titleFallback: null
    });
  });

  it("accepts canonical workspace link labels", () => {
    expect(
      resolveAgentGUIConversationTitle("@aa.md 这是什么内容", "codex")
    ).toEqual({
      title: "@aa.md 这是什么内容",
      titleFallback: null
    });
  });

  it("resolves generic-agent fallback labels in the view layer", () => {
    expect(
      resolveAgentGUIConversationDisplayTitle(
        {
          title: "",
          titleFallback: "generic-agent"
        },
        "Agent"
      )
    ).toBe("Agent");
  });

  it("strips trailing periods from agent GUI display fallback labels", () => {
    expect(
      resolveAgentGUIConversationDisplayTitle(
        {
          title: "",
          titleFallback: "generic-agent"
        },
        "Agent."
      )
    ).toBe("Agent");
  });

  it("resolves provider display labels with unknown falling back to Agent", () => {
    expect(resolveAgentGUIProviderDisplayLabel("claude-code", "Agent")).toBe(
      "Claude Code"
    );
    expect(resolveAgentGUIProviderDisplayLabel("unknown", "Agent")).toBe(
      "Agent"
    );
  });

  it("resolves dock conversation titles only from real conversation titles", () => {
    expect(
      resolveAgentGUIDockConversationTitle({
        provider: "codex",
        title: "Codex",
        titleFallback: null
      })
    ).toBeNull();
    expect(
      resolveAgentGUIDockConversationTitle({
        provider: "unknown",
        title: "",
        titleFallback: "generic-agent"
      })
    ).toBeNull();
    expect(
      resolveAgentGUIDockConversationTitle({
        provider: "hermes",
        title: "Ship the import flow.",
        titleFallback: null
      })
    ).toBe("Ship the import flow.");
  });

  it("resolves explicit conversation titles independently from dock display", () => {
    expect(
      resolveAgentGUIExplicitConversationTitle({
        provider: "codex",
        title: "Create App: System Monitor",
        titleFallback: null
      })
    ).toBe("Create App: System Monitor");
    expect(
      resolveAgentGUIExplicitConversationTitle({
        provider: "codex",
        title: "Codex",
        titleFallback: null
      })
    ).toBeNull();
  });
});

function timelineItem(
  overrides: Partial<WorkspaceAgentActivityTimelineItem>
): WorkspaceAgentActivityTimelineItem {
  return {
    id: 1,
    workspaceId: "room-1",
    agentSessionId: "session-1",
    seq: 1,
    eventId: "event-1",
    actorType: "agent",
    actorId: "codex",
    itemType: "event",
    occurredAtUnixMs: 1,
    createdAtUnixMs: 1,
    ...overrides
  };
}
