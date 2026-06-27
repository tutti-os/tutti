import { describe, expect, it, vi } from "vitest";
import {
  loadWorkspaceAgentSessionMessagePages,
  mergeWorkspaceAgentMessages
} from "./workspaceAgentSessionMessages";
import type { WorkspaceAgentActivityMessage } from "../shared/workspaceAgentActivityTypes";

describe("loadWorkspaceAgentSessionMessagePages", () => {
  it("keeps following hasMore past the old five-page default", async () => {
    const messages = Array.from({ length: 7 }, (_, index) =>
      messageWithVersion(index + 1)
    );
    const listSessionMessages = vi.fn(async ({ afterVersion = 0 }) => {
      const page = messages
        .filter((message) => message.version > afterVersion)
        .slice(0, 1);
      return {
        messages: page,
        latestVersion: page.at(-1)?.version ?? afterVersion,
        hasMore: messages.some(
          (message) => message.version > (page.at(-1)?.version ?? afterVersion)
        )
      };
    });

    const result = await loadWorkspaceAgentSessionMessagePages({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      limit: 1,
      listSessionMessages
    });

    expect(result.map((message) => message.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7
    ]);
    expect(listSessionMessages).toHaveBeenCalledTimes(7);
  });

  it("uses latestVersion as the next cursor when it advances past returned messages", async () => {
    const listSessionMessages = vi.fn(async ({ afterVersion = 0 }) => {
      if (afterVersion === 0) {
        return {
          messages: [messageWithVersion(1)],
          latestVersion: 10,
          hasMore: true
        };
      }
      if (afterVersion === 10) {
        return {
          messages: [messageWithVersion(11)],
          latestVersion: 11,
          hasMore: false
        };
      }
      return {
        messages: [],
        latestVersion: afterVersion,
        hasMore: false
      };
    });

    const result = await loadWorkspaceAgentSessionMessagePages({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      limit: 20,
      listSessionMessages
    });

    expect(result.map((message) => message.version)).toEqual([1, 11]);
    expect(listSessionMessages).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ afterVersion: 10 })
    );
  });

  it("orders merged messages by activity version before host id", () => {
    const result = mergeWorkspaceAgentMessages(
      [messageWithVersion(2, { id: 1, messageId: "message-2" })],
      [messageWithVersion(1, { id: 2, messageId: "message-1" })]
    );

    expect(result.map((message) => message.version)).toEqual([1, 2]);
  });
});

function messageWithVersion(
  version: number,
  overrides: Partial<WorkspaceAgentActivityMessage> = {}
): WorkspaceAgentActivityMessage {
  return {
    agentSessionId: "session-1",
    id: version,
    kind: "text",
    messageId: `message-${version}`,
    occurredAtUnixMs: version,
    payload: { text: `message ${version}` },
    role: "assistant",
    startedAtUnixMs: version,
    status: "completed",
    turnId: `turn-${version}`,
    version,
    ...overrides
  };
}
