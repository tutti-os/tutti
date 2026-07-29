import { describe, expect, it, vi } from "vitest";
import * as conversationRailRuntimeModule from "./agentConversationRailRuntime";
import {
  createAgentConversationRailRuntime,
  type AgentConversationRailRuntimeSource
} from "./agentConversationRailRuntime";

describe("createAgentConversationRailRuntime", () => {
  it("publishes only the host runtime factory as a JavaScript value", () => {
    expect(Object.keys(conversationRailRuntimeModule)).toEqual([
      "createAgentConversationRailRuntime"
    ]);
  });

  it("exposes one complete conversation rail capability cohort", () => {
    const runtime = createAgentConversationRailRuntime(createSource());

    expect(Object.keys(runtime).sort()).toEqual([
      "deleteSessionsBatch",
      "listPinnedSessionsPage",
      "listSessionSectionDeletionCandidates",
      "listSessionSectionPage",
      "listSessionSections",
      "listSessionsPage"
    ]);
  });

  it("forwards exact query and mutation inputs to the host source", async () => {
    const source = createSource();
    const runtime = createAgentConversationRailRuntime(source);
    const candidateInput = {
      agentTargetId: "target-1",
      excludePinned: true,
      sectionKey: "project:workspace-1:/repo",
      workspaceId: "workspace-1"
    };
    const deleteInput = {
      sessionIds: ["session-1", "session-2"],
      workspaceId: "workspace-1"
    };

    await runtime.listSessionSectionDeletionCandidates(candidateInput);
    await runtime.deleteSessionsBatch(deleteInput);

    expect(source.listSessionSectionDeletionCandidates).toHaveBeenCalledWith(
      candidateInput
    );
    expect(source.deleteSessionsBatch).toHaveBeenCalledWith(deleteInput);
  });
});

function createSource() {
  const source = {
    deleteSessionsBatch: vi.fn(async () => ({
      cleanupFailedSessionIds: [],
      removedMessages: 0,
      removedSessionIds: [],
      removedSessions: 0
    })),
    listPinnedSessionsPage: vi.fn(async (input) => ({
      hasMore: false,
      sessions: [],
      totalCount: 0,
      workspaceId: input.workspaceId
    })),
    listSessionSectionDeletionCandidates: vi.fn(async (input) => ({
      excludePinned: input.excludePinned,
      sectionKey: input.sectionKey,
      sessionIds: [],
      workspaceId: input.workspaceId
    })),
    listSessionSectionPage: vi.fn(async (input) => ({
      hasMore: false,
      kind: "project" as const,
      sectionKey: input.sectionKey,
      sessions: [],
      totalCount: 0
    })),
    listSessionSections: vi.fn(async (input) => ({
      sections: [],
      workspaceId: input.workspaceId
    })),
    listSessionsPage: vi.fn(async (input) => ({
      hasMore: false,
      sessions: [],
      workspaceId: input.workspaceId
    }))
  } satisfies AgentConversationRailRuntimeSource;
  return source;
}
