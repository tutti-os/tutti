import { describe, expect, it } from "vitest";
import {
  groupMessageCenterItems,
  messageCenterAgentUserStackId,
  messageCenterStackScrollSyncSegment,
  partitionMessageCenterItemsByAgentUser
} from "./workspaceAgentMessageCenterViewModel";
import type { WorkspaceAgentMessageCenterItem } from "./workspaceAgentMessageCenterModel";

describe("partitionMessageCenterItemsByAgentUser", () => {
  it("stacks only sessions with the same agent provider and user id", () => {
    const stacks = partitionMessageCenterItemsByAgentUser([
      item({
        agentSessionId: "codex-user-a-1",
        provider: "codex",
        userId: "user-a"
      }),
      item({
        agentSessionId: "codex-user-a-2",
        provider: "codex",
        userId: "user-a"
      }),
      item({
        agentSessionId: "codex-user-b",
        provider: "codex",
        userId: "user-b"
      }),
      item({
        agentSessionId: "gemini-user-a",
        provider: "gemini",
        userId: "user-a"
      })
    ]);

    expect(
      stacks.map((stack) => ({
        id: stack.id,
        provider: stack.provider,
        userId: stack.userId,
        sessionIds: stack.items.map((item) => item.agentSessionId)
      }))
    ).toEqual([
      {
        id: "agent-user:codex:user-a",
        provider: "codex",
        userId: "user-a",
        sessionIds: ["codex-user-a-1", "codex-user-a-2"]
      },
      {
        id: "agent-user:codex:user-b",
        provider: "codex",
        userId: "user-b",
        sessionIds: ["codex-user-b"]
      },
      {
        id: "agent-user:gemini:user-a",
        provider: "gemini",
        userId: "user-a",
        sessionIds: ["gemini-user-a"]
      }
    ]);
  });

  it("normalizes provider casing and blank user ids in the stack key", () => {
    expect(
      messageCenterAgentUserStackId({
        provider: " Codex ",
        userId: " user-a "
      })
    ).toBe("agent-user:codex:user-a");
    expect(
      messageCenterAgentUserStackId({
        provider: " ",
        userId: null
      })
    ).toBe("agent-user:unknown-agent:unknown-user");
  });

  it("summarizes collapsed stack scroll sync keys without every stacked item id", () => {
    const stack = partitionMessageCenterItemsByAgentUser([
      item({
        agentSessionId: "codex-user-a-1",
        provider: "codex",
        userId: "user-a"
      }),
      item({
        agentSessionId: "codex-user-a-2",
        provider: "codex",
        userId: "user-a"
      }),
      item({
        agentSessionId: "codex-user-a-3",
        provider: "codex",
        userId: "user-a"
      })
    ])[0];
    if (!stack) {
      throw new Error("Expected a stack to be created.");
    }

    const collapsed = messageCenterStackScrollSyncSegment({
      expanded: false,
      groupId: "working",
      stack
    });
    const expanded = messageCenterStackScrollSyncSegment({
      expanded: true,
      groupId: "working",
      stack
    });

    expect(collapsed).toContain("collapsed:working:agent-user:codex:user-a");
    expect(collapsed).toContain("message-center-codex-user-a-1");
    expect(collapsed).not.toContain("message-center-codex-user-a-2");
    expect(collapsed).not.toContain("message-center-codex-user-a-3");
    expect(expanded).toContain("message-center-codex-user-a-1");
    expect(expanded).toContain("message-center-codex-user-a-2");
    expect(expanded).toContain("message-center-codex-user-a-3");
  });
});

describe("groupMessageCenterItems", () => {
  it("groups the agent view by provider and user id", () => {
    const groups = groupMessageCenterItems(
      [
        item({
          agentSessionId: "codex-user-a-1",
          provider: "codex",
          userId: "user-a",
          identity: {
            userName: "Jessica",
            agentName: "Codex"
          }
        }),
        item({
          agentSessionId: "codex-user-a-2",
          provider: "codex",
          userId: "user-a",
          identity: {
            userName: "Jessica",
            agentName: "Codex"
          }
        }),
        item({
          agentSessionId: "codex-user-b",
          provider: "codex",
          userId: "user-b",
          identity: {
            userName: "Taylor",
            agentName: "Codex"
          }
        })
      ],
      "agent",
      (key) => key
    );

    expect(
      groups.map((group) => ({
        id: group.id,
        label: group.label,
        provider: group.provider,
        userId: group.userId,
        sessionIds: group.items.map((item) => item.agentSessionId)
      }))
    ).toEqual([
      {
        id: "agent-user:codex:user-a",
        label: "Jessica & Codex",
        provider: "codex",
        userId: "user-a",
        sessionIds: ["codex-user-a-1", "codex-user-a-2"]
      },
      {
        id: "agent-user:codex:user-b",
        label: "Taylor & Codex",
        provider: "codex",
        userId: "user-b",
        sessionIds: ["codex-user-b"]
      }
    ]);
  });

  it("splits failed items into their own group in the priority view", () => {
    const groups = groupMessageCenterItems(
      [
        item({
          agentSessionId: "waiting-session",
          status: "working",
          needsAttentionKind: "question"
        }),
        item({
          agentSessionId: "failed-session",
          status: "failed"
        })
      ],
      "priority",
      (key) => key
    );

    expect(
      groups.map((group) => ({
        id: group.id,
        sessionIds: group.items.map((entry) => entry.agentSessionId)
      }))
    ).toEqual([
      {
        id: "needs-attention",
        sessionIds: ["waiting-session"]
      },
      {
        id: "failed",
        sessionIds: ["failed-session"]
      }
    ]);
  });

  it("keeps imported completed items out of the recently completed group", () => {
    const now = Date.now();
    const groups = groupMessageCenterItems(
      [
        item({
          agentSessionId: "recent-runtime",
          lastAgentMessageAtUnixMs: now,
          sortTimeUnixMs: now,
          status: "completed"
        }),
        item({
          agentSessionId: "recent-imported",
          imported: true,
          lastAgentMessageAtUnixMs: now,
          sortTimeUnixMs: now,
          status: "completed"
        })
      ],
      "priority",
      (key) => key
    );

    expect(
      groups.map((group) => ({
        id: group.id,
        sessionIds: group.items.map((entry) => entry.agentSessionId)
      }))
    ).toEqual([
      {
        id: "recently-completed",
        sessionIds: ["recent-runtime"]
      },
      {
        id: "completed",
        sessionIds: ["recent-imported"]
      }
    ]);
  });
});

function item(
  overrides: Partial<WorkspaceAgentMessageCenterItem> & {
    agentSessionId: string;
  }
): WorkspaceAgentMessageCenterItem {
  const { agentSessionId, ...rest } = overrides;
  return {
    id: `message-center-${agentSessionId}`,
    agentSessionId,
    provider: "codex",
    userId: null,
    title: agentSessionId,
    identity: null,
    cwd: "/workspace",
    status: "working",
    digest: {
      primary: {
        kind: "progress",
        summary: `${agentSessionId} summary`,
        occurredAtUnixMs: 1
      }
    },
    lastAgentMessageSummary: `${agentSessionId} summary`,
    lastAgentMessageAtUnixMs: 1,
    pendingPrompt: null,
    needsAttentionKind: null,
    needsAttentionSummary: null,
    sortTimeUnixMs: 1,
    ...rest
  };
}
