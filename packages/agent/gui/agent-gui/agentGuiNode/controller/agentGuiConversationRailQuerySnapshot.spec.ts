import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import { describe, expect, it } from "vitest";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import {
  EMPTY_CONVERSATION_SEARCH_QUERY_STATE,
  createConversationRailQuerySnapshotSelector
} from "./agentConversationRailQuerySnapshot";
import { createConversationRailConversationsSelector } from "./agentGuiConversationRailQuerySnapshot";

describe("createConversationRailQuerySnapshotSelector", () => {
  it("projects only rail-owned sessions and preserves unchanged identities", () => {
    const engine = createTestAgentSessionEngine();
    const sessions = Array.from({ length: 176 }, (_, index) =>
      createSession(`session-${index}`, `Session ${index}`, index + 1)
    );
    engine.dispatch({ sessions, type: "session/snapshotReceived" });

    const querySnapshot = createConversationRailQuerySnapshotSelector()(
      {
        queryState: {
          pending: false,
          reconcilingSessionIds: ["session-2"],
          resolvedScopeKey: "all",
          sectionPageStates: new Map(),
          sections: [
            {
              id: "conversations",
              kind: "conversations" as const,
              project: null,
              sessionIds: ["session-0", "session-1"]
            }
          ]
        },
        runtimeRailFailed: false,
        runtimeSectionsEnabled: true,
        searchEnabled: true,
        searchQuery: "session",
        searchRequestKey: "search:session",
        searchState: {
          ...EMPTY_CONVERSATION_SEARCH_QUERY_STATE,
          requestKey: "search:session",
          resolvedQuery: "session",
          sessionIds: ["session-3"]
        }
      },
      undefined
    );
    const selectConversations = createConversationRailConversationsSelector();
    const first = selectConversations({
      engineState: engine.getSnapshot(),
      interactionLocked: false,
      querySnapshot
    });

    expect(first.map(({ id }) => id)).toEqual([
      "session-0",
      "session-1",
      "session-2",
      "session-3"
    ]);

    engine.dispatch({
      session: createSession("session-175", "Unrelated update", 1_000),
      type: "session/upserted"
    });
    const afterUnrelatedUpdate = selectConversations(
      {
        engineState: engine.getSnapshot(),
        interactionLocked: false,
        querySnapshot
      },
      first
    );
    expect(afterUnrelatedUpdate).toBe(first);

    engine.dispatch({
      session: createSession("session-1", "Changed title", 2_000),
      type: "session/upserted"
    });
    const afterVisibleUpdate = selectConversations(
      {
        engineState: engine.getSnapshot(),
        interactionLocked: false,
        querySnapshot
      },
      afterUnrelatedUpdate
    );

    expect(afterVisibleUpdate).not.toBe(first);
    expect(afterVisibleUpdate[0]).toBe(first[0]);
    expect(afterVisibleUpdate[1]).not.toBe(first[1]);
    expect(afterVisibleUpdate[1]?.title).toBe("Changed title");
    expect(afterVisibleUpdate[2]).toBe(first[2]);
    expect(afterVisibleUpdate[3]).toBe(first[3]);

    engine.dispose();
  });
});

function createSession(
  agentSessionId: string,
  title: string,
  updatedAtUnixMs: number
) {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId,
    agentTargetId: "local:codex",
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    railSectionKey: "conversations",
    title,
    updatedAtUnixMs,
    workspaceId: "test-workspace"
  });
}
