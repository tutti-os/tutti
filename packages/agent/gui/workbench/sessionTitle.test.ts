import { describe, expect, it } from "vitest";
import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import {
  formatAgentGuiSessionPlainTitle,
  resolveAgentGuiWorkbenchSessionTitle
} from "./sessionTitle";

describe("agent GUI workbench session titles", () => {
  it("formats raw mention markdown from snapshot titles", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: "Stale session title",
      provider: "codex",
      snapshot: snapshotWithSession({
        agentSessionId: "session-1",
        title:
          "[@automation 发布](mention://user/automation?workspaceId=workspace-1) 帮我跟进"
      })
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "snapshot",
      title: "@automation 发布 帮我跟进"
    });
  });

  it("formats workspace issue mention titles like the conversation rail", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: null,
      provider: "codex",
      snapshot: snapshotWithSession({
        agentSessionId: "session-1",
        title:
          "[@调研 spool 仓库 这个任务](mention://workspace-issue/issue-1?workspaceId=workspace-1)"
      })
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "snapshot",
      title: "@调研 spool 仓库 这个任务"
    });
  });

  it("does not expose provider-only session titles as conversation titles", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: null,
      provider: "codex",
      snapshot: snapshotWithSession({
        agentSessionId: "session-1",
        title: "Codex"
      })
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "none",
      title: null
    });
  });

  it("does not expose localized untitled placeholders as conversation titles", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: null,
      provider: "codex",
      snapshot: snapshotWithSession({
        agentSessionId: "session-1",
        title: "Current task"
      })
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "none",
      title: null
    });
  });

  it("uses the first user message when the snapshot title is not displayable", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: null,
      provider: "codex",
      snapshot: snapshotWithSession({
        agentSessionId: "session-1",
        messages: [
          message({ role: "assistant", text: "Working on it", version: 1 }),
          message({ role: "user", text: "Ship the title fix.", version: 2 })
        ],
        title: "Codex"
      })
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "snapshot",
      title: "Ship the title fix"
    });
  });

  it("uses the persisted title only as a formatted hydration fallback", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle:
        "[@automation 发布](mention://user/automation?workspaceId=workspace-1) 帮我跟进",
      provider: "codex",
      snapshot: {
        workspaceId: "workspace-1",
        presences: [],
        sessions: [],
        sessionMessagesById: {}
      }
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "fallback",
      title: "@automation 发布 帮我跟进"
    });
  });

  it("does not reuse the persisted fallback after live snapshot data exists", () => {
    const title = resolveAgentGuiWorkbenchSessionTitle({
      agentSessionId: "session-1",
      fallbackTitle: "Stale session title",
      provider: "codex",
      snapshot: snapshotWithSession({
        agentSessionId: "session-1",
        title: "Codex"
      })
    });

    expect(title).toEqual({
      agentSessionId: "session-1",
      source: "none",
      title: null
    });
  });

  it("formats plain titles for message center and toast surfaces", () => {
    expect(
      formatAgentGuiSessionPlainTitle(
        "[@automation 发布](mention://user/automation?workspaceId=workspace-1) 帮我跟进"
      )
    ).toBe("@automation 发布 帮我跟进");
  });
});

function snapshotWithSession(input: {
  agentSessionId: string;
  messages?: AgentActivitySnapshot["sessionMessagesById"][string];
  title: string;
}): AgentActivitySnapshot {
  return {
    workspaceId: "workspace-1",
    presences: [],
    sessions: [
      {
        workspaceId: "workspace-1",
        agentSessionId: input.agentSessionId,
        provider: "codex",
        providerSessionId: input.agentSessionId,
        cwd: "/workspace",
        title: input.title,
        status: "ready",
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2
      }
    ],
    sessionMessagesById: {
      [input.agentSessionId]: input.messages ?? []
    }
  };
}

function message(input: {
  role: "assistant" | "user";
  text: string;
  version: number;
}): AgentActivitySnapshot["sessionMessagesById"][string][number] {
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
