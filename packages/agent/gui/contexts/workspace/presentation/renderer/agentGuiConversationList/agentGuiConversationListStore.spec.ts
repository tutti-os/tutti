import { afterEach, describe, expect, it } from "vitest";
import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "../../../../../agentActivityRuntime";
import {
  resetAgentActivityRuntimeForTests,
  setAgentActivityRuntimeForTests
} from "../../../../../agentActivityRuntime";
import type { WorkspaceAgentActivitySnapshot } from "../../../../../shared/workspaceAgentActivityTypes";
import {
  ensureAgentGUIConversationListQuery,
  getAgentGUIConversationListQuerySnapshot,
  markAgentGUIConversationCompletionObserved,
  resetAgentGUIConversationListStoreForTests,
  scheduleAgentGUIConversationListProjection,
  setAgentGUIConversationListActiveConversation,
  updateAgentGUIConversationListConversations,
  upsertLocalCreatedAgentGUIConversation,
  type AgentGUIConversationListQuery
} from "./agentGuiConversationListStore";
import type { AgentGUIConversationSummary } from "../../../../../agent-gui/agentGuiNode/model/agentGuiConversationModel";

describe("agentGuiConversationListStore", () => {
  afterEach(() => {
    resetAgentGUIConversationListStoreForTests();
    resetAgentActivityRuntimeForTests();
  });

  it("projects workspace agent runtime updates without reloading sessions", async () => {
    const query: AgentGUIConversationListQuery = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    };
    let snapshot: WorkspaceAgentActivitySnapshot = emptySnapshot();
    let loadCount = 0;
    let runtimeListener: (() => void) | undefined;
    setAgentActivityRuntimeForTests({
      getSnapshot: () => snapshot,
      load: async () => {
        loadCount += 1;
        return snapshot;
      },
      subscribe: (_workspaceId, listener) => {
        runtimeListener = () => listener(snapshot as AgentActivitySnapshot);
        return () => {};
      }
    } as Partial<AgentActivityRuntime> as AgentActivityRuntime);

    ensureAgentGUIConversationListQuery(query);
    scheduleAgentGUIConversationListProjection(query, "projection-sync");
    await waitFor(() => {
      expect(loadCount).toBe(1);
      expect(getAgentGUIConversationListQuerySnapshot(query)?.initialized).toBe(
        true
      );
    });

    snapshot = {
      ...snapshot,
      sessions: [
        {
          workspaceId: "workspace-1",
          agentSessionId: "agent-session-1",
          provider: "codex",
          cwd: "/repo",
          title: "Investigate logs",
          status: "working",
          updatedAtUnixMs: 2,
          sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
        }
      ]
    };
    runtimeListener?.();

    await waitFor(() => {
      const querySnapshot = getAgentGUIConversationListQuerySnapshot(query);
      expect(loadCount).toBe(1);
      expect(querySnapshot?.conversations).toHaveLength(1);
      expect(querySnapshot?.conversations[0]?.id).toBe("agent-session-1");
    });
  });

  it("keeps existing conversations during incremental runtime updates that omit one session", async () => {
    const query: AgentGUIConversationListQuery = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    };
    let snapshot: WorkspaceAgentActivitySnapshot = {
      ...emptySnapshot(),
      sessions: [
        runtimeSession("a", 3_000),
        runtimeSession("z", 2_000),
        runtimeSession("b", 1_000)
      ]
    };
    let loadCount = 0;
    let runtimeListener: (() => void) | undefined;
    setAgentActivityRuntimeForTests({
      getSnapshot: () => snapshot,
      load: async () => {
        loadCount += 1;
        return snapshot;
      },
      subscribe: (_workspaceId, listener) => {
        runtimeListener = () => listener(snapshot as AgentActivitySnapshot);
        return () => {};
      }
    } as Partial<AgentActivityRuntime> as AgentActivityRuntime);

    ensureAgentGUIConversationListQuery(query);
    scheduleAgentGUIConversationListProjection(query, "projection-sync");
    await waitFor(() => {
      expect(
        getAgentGUIConversationListQuerySnapshot(query)?.conversations.map(
          (item) => item.id
        )
      ).toEqual(["a", "z", "b"]);
    });

    snapshot = {
      ...snapshot,
      sessions: [runtimeSession("a", 3_500), runtimeSession("b", 1_000)]
    };
    runtimeListener?.();

    await waitFor(() => {
      expect(loadCount).toBe(1);
      expect(
        getAgentGUIConversationListQuerySnapshot(query)?.conversations.map(
          (item) => item.id
        )
      ).toEqual(["a", "z", "b"]);
    });

    scheduleAgentGUIConversationListProjection(query, "projection-sync");
    await waitFor(() => {
      expect(loadCount).toBe(2);
      expect(
        getAgentGUIConversationListQuerySnapshot(query)?.conversations.map(
          (item) => item.id
        )
      ).toEqual(["a", "b"]);
    });
  });

  it("sorts conversations by stable sort time before update time", () => {
    const query: AgentGUIConversationListQuery = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    };
    ensureAgentGUIConversationListQuery(query);

    updateAgentGUIConversationListConversations(query, () => [
      conversation("older-start-with-newer-message", {
        sortTimeUnixMs: 1_000,
        updatedAtUnixMs: 9_000
      }),
      conversation("newer-start-with-older-message", {
        sortTimeUnixMs: 2_000,
        updatedAtUnixMs: 2_000
      })
    ]);

    expect(
      getAgentGUIConversationListQuerySnapshot(query)?.conversations.map(
        (item) => item.id
      )
    ).toEqual([
      "newer-start-with-older-message",
      "older-start-with-newer-message"
    ]);
  });

  it("marks completed conversations unread only when no owner has them active", () => {
    const query: AgentGUIConversationListQuery = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    };
    ensureAgentGUIConversationListQuery(query);

    updateAgentGUIConversationListConversations(query, () => [
      conversation("session-1", {
        status: "completed"
      })
    ]);
    markAgentGUIConversationCompletionObserved({
      query,
      conversationId: "session-1"
    });

    expect(
      getAgentGUIConversationListQuerySnapshot(query)?.conversations[0]
        ?.hasUnreadCompletion
    ).toBe(true);

    setAgentGUIConversationListActiveConversation({
      query,
      ownerKey: "panel-1",
      conversationId: "session-1"
    });
    markAgentGUIConversationCompletionObserved({
      query,
      conversationId: "session-1"
    });

    expect(
      getAgentGUIConversationListQuerySnapshot(query)?.conversations[0]
        ?.hasUnreadCompletion
    ).toBe(false);
  });

  it("preserves projected project metadata when durable refresh has the same cwd without project metadata", () => {
    const query: AgentGUIConversationListQuery = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    };
    ensureAgentGUIConversationListQuery(query);

    upsertLocalCreatedAgentGUIConversation({
      query,
      conversation: conversation("session-1", {
        cwd: "/workspace/app",
        project: {
          id: "app",
          path: "/workspace/app",
          label: "App"
        },
        updatedAtUnixMs: 1
      })
    });
    upsertLocalCreatedAgentGUIConversation({
      query,
      conversation: conversation("session-1", {
        cwd: "/workspace/app",
        project: null,
        updatedAtUnixMs: 2
      })
    });

    expect(
      getAgentGUIConversationListQuerySnapshot(query)?.conversations[0]?.project
    ).toEqual({
      id: "app",
      path: "/workspace/app",
      label: "App"
    });
  });

  it("drops projected project metadata when durable refresh changes cwd without project metadata", () => {
    const query: AgentGUIConversationListQuery = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    };
    ensureAgentGUIConversationListQuery(query);

    upsertLocalCreatedAgentGUIConversation({
      query,
      conversation: conversation("session-1", {
        cwd: "/workspace/app",
        project: {
          id: "app",
          path: "/workspace/app",
          label: "App"
        },
        updatedAtUnixMs: 1
      })
    });
    upsertLocalCreatedAgentGUIConversation({
      query,
      conversation: conversation("session-1", {
        cwd: "/workspace/other",
        project: null,
        updatedAtUnixMs: 2
      })
    });

    expect(
      getAgentGUIConversationListQuerySnapshot(query)?.conversations[0]?.project
    ).toBeNull();
  });
});

function emptySnapshot(): WorkspaceAgentActivitySnapshot {
  return {
    workspaceId: "workspace-1",
    presences: [],
    sessions: [],
    sessionMessagesById: {}
  };
}

function runtimeSession(
  agentSessionId: string,
  updatedAtUnixMs: number
): WorkspaceAgentActivitySnapshot["sessions"][number] {
  return {
    workspaceId: "workspace-1",
    agentSessionId,
    provider: "codex",
    cwd: "/repo",
    title: agentSessionId,
    status: "ready",
    updatedAtUnixMs,
    sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
  };
}

function conversation(
  id: string,
  overrides: Partial<AgentGUIConversationSummary>
): AgentGUIConversationSummary {
  return {
    id,
    provider: "codex",
    title: id,
    status: "ready",
    cwd: "/repo",
    updatedAtUnixMs: 1,
    ...overrides
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | undefined;
  while (Date.now() - startedAt < 1000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError) {
    throw lastError;
  }
}
