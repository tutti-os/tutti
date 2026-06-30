import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "../../../../../agentActivityRuntime";
import {
  resetAgentActivityRuntimeForTests,
  setAgentActivityRuntimeForTests
} from "../../../../../agentActivityRuntime";
import {
  resetAgentHostApiForTests,
  setAgentHostApiForTests
} from "../../../../../agentActivityHost";
import type {
  WorkspaceAgentActivityMessage,
  WorkspaceAgentActivitySnapshot
} from "../../../../../shared/workspaceAgentActivityTypes";
import {
  ensureAgentGUIConversationListQuery,
  getAgentGUIConversationListQuerySnapshot,
  markAgentGUIConversationCompletionObserved,
  resetAgentGUIConversationListStoreForTests,
  scheduleAgentGUIConversationListProjection,
  setAgentGUIConversationListActiveConversation,
  setAgentGUIConversationListConversationsForTests,
  type AgentGUIConversationListQuery
} from "./agentGuiConversationListStore";
import type { AgentGUIConversationSummary } from "../../../../../agent-gui/agentGuiNode/model/agentGuiConversationModel";
import {
  hydrateAgentSessionViewOverlayMessages,
  resetAgentSessionViewStoreForTests
} from "../agentSessions/agentSessionViewStore";

describe("agentGuiConversationListStore", () => {
  afterEach(() => {
    resetAgentGUIConversationListStoreForTests();
    resetAgentSessionViewStoreForTests();
    resetAgentActivityRuntimeForTests();
    resetAgentHostApiForTests();
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

  it("updates only dirty conversation projections for overlay message refreshes", async () => {
    const query: AgentGUIConversationListQuery = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    };
    const snapshot: WorkspaceAgentActivitySnapshot = {
      ...emptySnapshot(),
      sessions: [
        runtimeSession("session-a", 2_000, { title: "Codex" }),
        runtimeSession("session-b", 1_000, { title: "Codex" })
      ]
    };
    let loadCount = 0;
    setAgentActivityRuntimeForTests({
      getSnapshot: () => snapshot,
      load: async () => {
        loadCount += 1;
        return snapshot;
      },
      subscribe: () => () => {}
    } as Partial<AgentActivityRuntime> as AgentActivityRuntime);

    ensureAgentGUIConversationListQuery(query);
    scheduleAgentGUIConversationListProjection(query, "projection-sync");
    await waitFor(() => {
      expect(
        getAgentGUIConversationListQuerySnapshot(query)?.conversations.map(
          (conversation) => conversation.id
        )
      ).toEqual(["session-a", "session-b"]);
    });
    const before =
      getAgentGUIConversationListQuerySnapshot(query)?.conversations ?? [];
    const previousSessionA = before[0]!;
    const previousSessionB = before[1]!;

    hydrateAgentSessionViewOverlayMessages([
      {
        workspaceId: "workspace-1",
        agentSessionId: "session-b",
        overlayMessages: [
          message("session-b", {
            messageId: "message-session-b-1",
            payload: { text: "Investigate renderer jank" }
          })
        ]
      }
    ]);
    scheduleAgentGUIConversationListProjection(
      query,
      "session-overlay-update",
      { dirtySessionIds: ["session-b"] }
    );

    await waitFor(() => {
      const conversations =
        getAgentGUIConversationListQuerySnapshot(query)?.conversations ?? [];
      expect(loadCount).toBe(1);
      expect(conversations).toHaveLength(2);
      expect(conversations[0]).toBe(previousSessionA);
      expect(conversations[1]).not.toBe(previousSessionB);
      expect(conversations[1]).toEqual(
        expect.objectContaining({
          id: "session-b",
          title: "Investigate renderer jank"
        })
      );
    });
  });

  it("marks background completed runtime updates unread during projection", async () => {
    const query: AgentGUIConversationListQuery = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    };
    let snapshot: WorkspaceAgentActivitySnapshot = {
      ...emptySnapshot(),
      sessions: [runtimeSession("session-1", 1_000)]
    };
    let runtimeListener: (() => void) | undefined;
    setAgentActivityRuntimeForTests({
      getSnapshot: () => snapshot,
      load: async () => snapshot,
      subscribe: (_workspaceId, listener) => {
        runtimeListener = () => listener(snapshot as AgentActivitySnapshot);
        return () => {};
      }
    } as Partial<AgentActivityRuntime> as AgentActivityRuntime);

    ensureAgentGUIConversationListQuery(query);
    scheduleAgentGUIConversationListProjection(query, "projection-sync");
    await waitFor(() => {
      expect(
        getAgentGUIConversationListQuerySnapshot(query)?.conversations[0]
          ?.status
      ).toBe("ready");
    });

    snapshot = {
      ...snapshot,
      sessions: [
        {
          ...runtimeSession("session-1", 2_000),
          status: "completed"
        }
      ]
    };
    runtimeListener?.();

    await waitFor(() => {
      expect(
        getAgentGUIConversationListQuerySnapshot(query)?.conversations[0]
      ).toEqual(
        expect.objectContaining({
          id: "session-1",
          status: "completed",
          hasUnreadCompletion: true
        })
      );
    });
  });

  it("does not mark a completed projection unread when its completion key was already read", async () => {
    const query: AgentGUIConversationListQuery = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    };
    const snapshot: WorkspaceAgentActivitySnapshot = {
      ...emptySnapshot(),
      sessions: [
        runtimeSession("session-1", 2_000, {
          status: "completed"
        })
      ]
    };
    setAgentActivityRuntimeForTests({
      getSnapshot: () => snapshot,
      load: async () => snapshot,
      subscribe: () => () => {}
    } as Partial<AgentActivityRuntime> as AgentActivityRuntime);
    setAgentHostApiForTests({
      clipboard: {},
      filesystem: {},
      workspace: {},
      persistence: {
        readWorkspaceAgentReadState: vi.fn(async () => ({
          completed: {
            readIds: ["session:session-1:completed"],
            unreadIds: []
          },
          failed: { readIds: [], unreadIds: [] }
        })),
        writeWorkspaceAgentReadState: vi.fn()
      }
    } as any);

    ensureAgentGUIConversationListQuery(query);
    scheduleAgentGUIConversationListProjection(query, "projection-sync");

    await waitFor(() => {
      expect(
        getAgentGUIConversationListQuerySnapshot(query)?.conversations[0]
      ).toEqual(
        expect.objectContaining({
          id: "session-1",
          status: "completed",
          hasUnreadCompletion: false,
          unreadCompletionKey: "session:session-1:completed"
        })
      );
    });
  });

  it("does not mark imported completed sessions unread during projection", async () => {
    const query: AgentGUIConversationListQuery = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    };
    const snapshot: WorkspaceAgentActivitySnapshot = {
      ...emptySnapshot(),
      sessions: [
        runtimeSession("imported-session-1", 2_000, {
          status: "completed",
          runtimeContext: {
            imported: true
          }
        })
      ]
    };
    setAgentActivityRuntimeForTests({
      getSnapshot: () => snapshot,
      load: async () => snapshot,
      subscribe: () => () => {}
    } as Partial<AgentActivityRuntime> as AgentActivityRuntime);

    ensureAgentGUIConversationListQuery(query);
    scheduleAgentGUIConversationListProjection(query, "projection-sync");

    await waitFor(() => {
      expect(
        getAgentGUIConversationListQuerySnapshot(query)?.conversations[0]
      ).toEqual(
        expect.objectContaining({
          id: "imported-session-1",
          status: "completed",
          hasUnreadCompletion: false,
          unreadCompletionKey: "session:imported-session-1:completed"
        })
      );
    });
  });

  it("marks a completed assistant message unread during projection", async () => {
    const query: AgentGUIConversationListQuery = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    };
    const snapshot: WorkspaceAgentActivitySnapshot = {
      ...emptySnapshot(),
      sessions: [runtimeSession("session-1", 2_000)],
      sessionMessagesById: {
        "session-1": [
          message("session-1", {
            messageId: "assistant-message-1",
            turnId: "turn-1",
            role: "assistant",
            kind: "text",
            status: "completed"
          })
        ]
      }
    };
    setAgentActivityRuntimeForTests({
      getSnapshot: () => snapshot,
      load: async () => snapshot,
      subscribe: () => () => {}
    } as Partial<AgentActivityRuntime> as AgentActivityRuntime);

    ensureAgentGUIConversationListQuery(query);
    scheduleAgentGUIConversationListProjection(query, "projection-sync");

    await waitFor(() => {
      expect(
        getAgentGUIConversationListQuerySnapshot(query)?.conversations[0]
      ).toEqual(
        expect.objectContaining({
          id: "session-1",
          status: "ready",
          hasUnreadCompletion: true,
          unreadCompletionKey: "turn:session-1:turn-1:completed"
        })
      );
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

    setAgentGUIConversationListConversationsForTests(query, [
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

    setAgentGUIConversationListConversationsForTests(query, [
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

  // NOTE: project metadata is no longer canonical store state — it is a
  // view-only JOIN of cwd × userProjects derived per-window in the view-model
  // layer (see useAgentGUINodeController visibleConversations). The store
  // structurally strips `project` at its write choke point, so the former
  // store-merge project tests were removed. View derivation is covered by the
  // controller and groupConversations specs.

  it("strips project metadata so it never becomes canonical store state", () => {
    const query: AgentGUIConversationListQuery = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    };
    ensureAgentGUIConversationListQuery(query);

    // Even if a write path hands the store a resolved project, it must not land
    // in canonical state (this is what prevented the cross-window storm).
    setAgentGUIConversationListConversationsForTests(query, [
      conversation("session-1", {
        cwd: "/workspace/app",
        project: {
          id: "app",
          path: "/workspace/app",
          label: "App"
        }
      })
    ]);

    const stored =
      getAgentGUIConversationListQuerySnapshot(query)?.conversations[0];
    expect(stored?.id).toBe("session-1");
    expect(stored?.project ?? null).toBeNull();
  });

  it("logs diagnostics when conversation updates churn in a short window", () => {
    const logRuntimeDiagnostics = vi.fn();
    setAgentHostApiForTests({
      clipboard: {},
      debug: { logRuntimeDiagnostics },
      filesystem: {},
      workspace: {}
    } as any);
    const query: AgentGUIConversationListQuery = {
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "codex",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    };
    ensureAgentGUIConversationListQuery(query);

    for (let index = 0; index < 8; index += 1) {
      setAgentGUIConversationListConversationsForTests(query, [
        conversation("session-1", {
          updatedAtUnixMs: index + 1
        })
      ]);
    }

    expect(logRuntimeDiagnostics).toHaveBeenCalledTimes(1);
    expect(logRuntimeDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent-gui.conversation-list.update-storm",
        level: "info",
        source: "renderer-workspace-surface",
        details: expect.objectContaining({
          changedFields: expect.stringContaining("updatedAtUnixMs"),
          nextCount: 1,
          previousCount: 1,
          provider: "codex",
          reason: "external-update",
          sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
          updateCount: 8,
          workspaceId: "workspace-1"
        })
      })
    );
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
  updatedAtUnixMs: number,
  overrides: Partial<WorkspaceAgentActivitySnapshot["sessions"][number]> = {}
): WorkspaceAgentActivitySnapshot["sessions"][number] {
  return {
    workspaceId: "workspace-1",
    agentSessionId,
    provider: "codex",
    cwd: "/repo",
    title: agentSessionId,
    status: "ready",
    updatedAtUnixMs,
    sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
    ...overrides
  };
}

function message(
  agentSessionId: string,
  overrides: Partial<WorkspaceAgentActivityMessage> = {}
): WorkspaceAgentActivityMessage {
  return {
    agentSessionId,
    messageId: overrides.messageId ?? `message-${agentSessionId}`,
    version: overrides.version ?? 1,
    turnId: overrides.turnId ?? `turn-${agentSessionId}`,
    role: overrides.role ?? "user",
    kind: overrides.kind ?? "message",
    payload: overrides.payload ?? { text: agentSessionId },
    occurredAtUnixMs: overrides.occurredAtUnixMs ?? 1_000,
    startedAtUnixMs: overrides.startedAtUnixMs ?? 1_000,
    ...overrides
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
