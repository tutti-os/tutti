import { describe, expect, it } from "vitest";
import {
  groupMessageCenterItems,
  messageCenterAgentUserStackId,
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
    lastAgentMessageSummary: `${agentSessionId} summary`,
    lastAgentMessageAtUnixMs: 1,
    pendingPrompt: null,
    needsAttentionKind: null,
    needsAttentionSummary: null,
    sortTimeUnixMs: 1,
    ...rest
  };
}
