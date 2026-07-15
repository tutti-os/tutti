import { describe, expect, it } from "vitest";
import {
  normalizeAgentActivitySession,
  type AgentActivityMessage,
  type AgentActivitySession
} from "@tutti-os/agent-activity-core";
import {
  resolveAgentGuiWorkbenchHeaderTitle,
  resolveAgentGuiWorkbenchSessionTitle
} from "./sessionTitle";

describe("agent GUI workbench header titles", () => {
  it("uses the selected agent name before a conversation title exists", () => {
    expect(
      resolveAgentGuiWorkbenchHeaderTitle({
        agentName: "Cursor",
        conversationTitle: null,
        provider: "cursor"
      })
    ).toBe("Cursor");
  });

  it("keeps the selected agent name after a conversation title exists", () => {
    expect(
      resolveAgentGuiWorkbenchHeaderTitle({
        agentName: "Cursor",
        conversationTitle: "Fix the header",
        provider: "cursor"
      })
    ).toBe("Cursor");
  });
});

describe("agent GUI workbench session titles", () => {
  it("uses canonical snapshot titles", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: "Stale session title",
      ...sessionState({
        agentSessionId: "session-1",
        title: "@automation 发布 帮我跟进"
      })
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "snapshot",
      title: "@automation 发布 帮我跟进"
    });
  });

  it("uses canonical workspace issue titles like the conversation rail", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: null,
      ...sessionState({
        agentSessionId: "session-1",
        title: "@调研 spool 仓库 这个任务"
      })
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "snapshot",
      title: "@调研 spool 仓库 这个任务"
    });
  });

  it("uses the engine optimistic title while the canonical title is empty", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: null,
      optimisticTitle: "test1",
      ...sessionState({ agentSessionId: "session-1", title: "" })
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "optimistic",
      title: "test1"
    });
  });

  it("prefers the canonical title over the engine optimistic title", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: null,
      optimisticTitle: "test1",
      ...sessionState({ agentSessionId: "session-1", title: "Canonical title" })
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "snapshot",
      title: "Canonical title"
    });
  });

  it("uses the canonical snapshot title without provider interpretation", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: null,
      ...sessionState({
        agentSessionId: "session-1",
        title: "Codex"
      })
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "snapshot",
      title: "Codex"
    });
  });

  it("uses the canonical snapshot title without localized interpretation", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: null,
      ...sessionState({
        agentSessionId: "session-1",
        title: "Current task"
      })
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "snapshot",
      title: "Current task"
    });
  });

  it("does not derive a title from snapshot messages", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: null,
      ...sessionState({
        agentSessionId: "session-1",
        messages: [
          message({ role: "assistant", text: "Working on it", version: 1 }),
          message({ role: "user", text: "Ship the title fix.", version: 2 })
        ],
        title: "Canonical title"
      })
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "snapshot",
      title: "Canonical title"
    });
  });

  it("uses the persisted canonical title only as a hydration fallback", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: "@automation 发布 帮我跟进"
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "fallback",
      title: "@automation 发布 帮我跟进"
    });
  });

  it("prefers live snapshot titles over persisted hydration fallback", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: "Stale session title",
      ...sessionState({
        agentSessionId: "session-1",
        title: "Codex"
      })
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "snapshot",
      title: "Codex"
    });
  });
});

function sessionState(input: {
  agentSessionId: string;
  messages?: AgentActivityMessage[];
  title: string;
}): { messages: AgentActivityMessage[]; session: AgentActivitySession } {
  return {
    messages: input.messages ?? [],
    session: normalizeAgentActivitySession({
      ...{
        activeTurnId: null,
        latestTurnInteractions: [],
        pendingInteractions: []
      },
      workspaceId: "workspace-1",
      agentSessionId: input.agentSessionId,
      provider: "codex",
      providerSessionId: input.agentSessionId,
      cwd: "/workspace",
      title: input.title,
      createdAtUnixMs: 1,
      updatedAtUnixMs: 2
    })
  };
}

function message(input: {
  role: "assistant" | "user";
  text: string;
  version: number;
}): AgentActivityMessage {
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    messageId: `message-${input.version}`,
    version: input.version,
    turnId: `turn-${input.version}`,
    role: input.role,
    kind: input.role === "user" ? "message.user" : "message.assistant",
    payload: {
      text: input.text
    },
    occurredAtUnixMs: input.version
  };
}
