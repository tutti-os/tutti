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

    const isolation = {
      mode: "worktree" as const,
      worktreePath: "/workspace/.worktrees/session-1",
      branch: "tutti/session-1",
      baseCommit: "base-commit"
    };
    engine.dispatch({
      session: createSession("session-1", "Changed title", 2_000, isolation),
      type: "session/upserted"
    });
    const afterIsolationProjection = selectConversations(
      {
        engineState: engine.getSnapshot(),
        interactionLocked: false,
        querySnapshot
      },
      afterVisibleUpdate
    );

    expect(afterIsolationProjection).not.toBe(afterVisibleUpdate);
    expect(afterIsolationProjection[0]).toBe(afterVisibleUpdate[0]);
    expect(afterIsolationProjection[1]).not.toBe(afterVisibleUpdate[1]);
    expect(afterIsolationProjection[1]?.isolation).toEqual(isolation);
    expect(afterIsolationProjection[2]).toBe(afterVisibleUpdate[2]);
    expect(afterIsolationProjection[3]).toBe(afterVisibleUpdate[3]);

    engine.dispose();
  });

  it("projects all running sessions for the exact target even before membership refresh", () => {
    const engine = createTestAgentSessionEngine();
    engine.dispatch({
      sessions: [
        createRunningSession("running-1", "local:codex"),
        createRunningSession("running-2", "local:codex"),
        createRunningSession("other-target", "local:opencode")
      ],
      type: "session/snapshotReceived"
    });
    const querySnapshot = createConversationRailQuerySnapshotSelector()(
      {
        agentTargetId: "local:codex",
        queryState: {
          pending: false,
          reconcilingSessionIds: [],
          resolvedScopeKey: "codex",
          sectionPageStates: new Map(),
          sections: []
        },
        runtimeRailFailed: false,
        runtimeSectionsEnabled: true,
        searchEnabled: false,
        searchQuery: "",
        searchRequestKey: null,
        searchState: EMPTY_CONVERSATION_SEARCH_QUERY_STATE
      },
      undefined
    );

    const projected = createConversationRailConversationsSelector()({
      engineState: engine.getSnapshot(),
      interactionLocked: false,
      querySnapshot
    });

    expect(projected.map(({ id }) => id)).toEqual(["running-1", "running-2"]);
    engine.dispose();
  });
});

function createRunningSession(agentSessionId: string, agentTargetId: string) {
  return normalizeAgentActivitySession({
    activeTurn: {
      agentSessionId,
      error: null,
      origin: "user_prompt",
      outcome: null,
      phase: "running",
      settledAtUnixMs: null,
      startedAtUnixMs: 1,
      turnId: `${agentSessionId}-turn`,
      updatedAtUnixMs: 2
    },
    activeTurnId: `${agentSessionId}-turn`,
    agentSessionId,
    agentTargetId,
    cwd: "/workspace",
    kind: "root",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: agentTargetId.replace("local:", ""),
    railSectionKey: "conversations",
    title: agentSessionId,
    updatedAtUnixMs: 2,
    workspaceId: "test-workspace"
  });
}

function createSession(
  agentSessionId: string,
  title: string,
  updatedAtUnixMs: number,
  isolation?: {
    mode: "worktree";
    worktreePath: string;
    branch: string;
    baseCommit: string;
  }
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
    ...(isolation ? { isolation } : {}),
    title,
    updatedAtUnixMs,
    workspaceId: "test-workspace"
  });
}
