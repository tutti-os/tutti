import { describe, expect, it, vi } from "vitest";
import {
  AGENT_CONVERSATION_RAIL_RUNTIME_METHODS,
  createAgentConversationRailRuntime,
  inspectAgentConversationBatchDeletionCapability,
  type AgentConversationRailRuntimeSource
} from "./agentConversationRailRuntime";

describe("createAgentConversationRailRuntime", () => {
  it("exposes one complete conversation rail capability cohort", () => {
    const runtime = createAgentConversationRailRuntime(createSource());

    for (const method of AGENT_CONVERSATION_RAIL_RUNTIME_METHODS) {
      expect(runtime[method], method).toBeTypeOf("function");
    }
  });

  it("owns normalized workspace query caches outside mounted rail controllers", () => {
    const runtime = createAgentConversationRailRuntime(createSource());

    const first = runtime.getSessionSectionsQueryCache("workspace-1");
    const same = runtime.getSessionSectionsQueryCache(" workspace-1 ");
    const other = runtime.getSessionSectionsQueryCache("workspace-2");

    expect(first).toBe(same);
    expect(first).not.toBe(other);
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

describe("inspectAgentConversationBatchDeletionCapability", () => {
  it("enables batch deletion only when both runtime methods exist", () => {
    expect(
      inspectAgentConversationBatchDeletionCapability({
        deleteSessionsBatch: vi.fn(),
        listSessionSectionDeletionCandidates: vi.fn()
      })
    ).toEqual({
      available: true,
      missingMethods: [],
      partial: false
    });
  });

  it("fails closed when only one half of the batch deletion contract exists", () => {
    expect(
      inspectAgentConversationBatchDeletionCapability({
        deleteSessionsBatch: vi.fn()
      })
    ).toEqual({
      available: false,
      missingMethods: ["listSessionSectionDeletionCandidates"],
      partial: true
    });
  });

  it("treats hosts without the optional capability as unavailable, not partial", () => {
    expect(inspectAgentConversationBatchDeletionCapability({})).toEqual({
      available: false,
      missingMethods: [
        "deleteSessionsBatch",
        "listSessionSectionDeletionCandidates"
      ],
      partial: false
    });
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
