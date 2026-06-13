import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentActivityMessage,
  AgentActivitySession,
  AgentActivitySnapshot,
  AgentActivitySnapshotListener
} from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "../../agentActivityRuntime";
import type {
  AgentHostActivateAgentSessionResult,
  AgentHostAgentSessionState,
  AgentHostUnactivateAgentSessionResult,
  AgentHostWorkspaceAgentTimelineItem
} from "../../shared/contracts/dto";
import {
  AGENT_GUI_BATCH_RUNNER_PROVIDERS,
  agentGuiBatchRunCaseResultKey,
  mergeAgentGuiBatchSessionTimelineItems,
  useAgentGuiBatchRunner
} from "./useAgentGuiBatchRunner";

type MockAgentHostApi = {
  agentGuiBatch: {
    exportRun: ReturnType<typeof vi.fn>;
  };
  agentSessions: {
    activate: ReturnType<typeof vi.fn>;
    getState: ReturnType<typeof vi.fn>;
    unactivate: ReturnType<typeof vi.fn>;
  };
  workspace: {
    selectFiles: ReturnType<typeof vi.fn>;
  };
  filesystem: {
    readFileText: ReturnType<typeof vi.fn>;
  };
};

type MockAgentActivityRuntime = AgentActivityRuntime & {
  emitMessages: (
    workspaceId: string,
    agentSessionId: string,
    messages: AgentActivityMessage[]
  ) => void;
  activateSession: ReturnType<typeof vi.fn>;
  getSessionControlState: ReturnType<typeof vi.fn>;
  listSessionMessages: ReturnType<typeof vi.fn>;
  sendInput: ReturnType<typeof vi.fn>;
  setSessionStatus: (
    workspaceId: string,
    agentSessionId: string,
    status: AgentActivitySession["status"]
  ) => void;
  unactivateSession: ReturnType<typeof vi.fn>;
};

type InstalledAgentHostApi = MockAgentHostApi & {
  agentActivityRuntime: MockAgentActivityRuntime;
};

function installAgentHostApi(
  overrides: Partial<MockAgentHostApi["agentSessions"]> = {}
): InstalledAgentHostApi {
  const agentSessions = {
    activate: vi.fn(
      async (payload: {
        agentSessionId: string;
      }): Promise<AgentHostActivateAgentSessionResult> => ({
        session: {
          workspaceId: "room-1",
          agentSessionId: payload.agentSessionId,
          provider: "codex",
          providerSessionId: `provider-${payload.agentSessionId}`,
          status: "ready",
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1
        },
        activation: { mode: "new", status: "attached" }
      })
    ),
    getState: vi.fn(async (payload: { agentSessionId: string }) => ({
      workspaceId: "room-1",
      agentSessionId: payload.agentSessionId,
      provider: "codex",
      status: "ready",
      updatedAtUnixMs: Date.now(),
      pendingInteractive: null
    })),
    unactivate: vi.fn(
      async (payload: {
        agentSessionId: string;
      }): Promise<AgentHostUnactivateAgentSessionResult> => ({
        agentSessionId: payload.agentSessionId,
        buffered: true
      })
    ),
    ...overrides
  };
  const agentHostApi: MockAgentHostApi = {
    agentGuiBatch: {
      exportRun: vi.fn(async () => ({
        filePath: "/tmp/out.zip",
        fileCount: 2,
        artifactCount: 0
      }))
    },
    agentSessions,
    workspace: {
      selectFiles: vi.fn(async () => [
        { id: "file-1", name: "cases.jsonl", path: "/tmp/cases.jsonl" }
      ])
    },
    filesystem: {
      readFileText: vi.fn(async () => ({
        content: '{"id":"a","prompt":"first"}\n{"id":"b","prompt":"second"}'
      }))
    }
  };
  (window as { agentHostApi?: unknown }).agentHostApi = { ...agentHostApi };
  const agentActivityRuntime = installAgentActivityRuntime(agentHostApi);
  return Object.assign(agentHostApi, { agentActivityRuntime });
}

function installAgentActivityRuntime(
  agentHostApi: MockAgentHostApi
): MockAgentActivityRuntime {
  const snapshots = new Map<string, AgentActivitySnapshot>();
  const listenersByWorkspaceId = new Map<
    string,
    Set<AgentActivitySnapshotListener>
  >();
  const getSnapshot = (workspaceId: string): AgentActivitySnapshot => {
    const existing = snapshots.get(workspaceId);
    if (existing) {
      return existing;
    }
    const snapshot: AgentActivitySnapshot = {
      workspaceId,
      presences: [],
      sessions: [],
      sessionMessagesById: {}
    };
    snapshots.set(workspaceId, snapshot);
    return snapshot;
  };
  const emitSnapshot = (workspaceId: string): void => {
    const snapshot = getSnapshot(workspaceId);
    for (const listener of listenersByWorkspaceId.get(workspaceId) ?? []) {
      listener(snapshot);
    }
  };
  const upsertSession = (
    workspaceId: string,
    agentSessionId: string,
    updates: Partial<AgentActivitySession>
  ): AgentActivitySession => {
    const snapshot = getSnapshot(workspaceId);
    const existing = snapshot.sessions.find(
      (candidate) => candidate.agentSessionId === agentSessionId
    );
    const session: AgentActivitySession = {
      workspaceId,
      agentSessionId,
      provider: "codex",
      cwd: "",
      title: "Codex",
      status: "ready",
      ...existing,
      ...updates
    };
    snapshots.set(workspaceId, {
      ...snapshot,
      sessions: existing
        ? snapshot.sessions.map((candidate) =>
            candidate.agentSessionId === agentSessionId ? session : candidate
          )
        : [...snapshot.sessions, session]
    });
    emitSnapshot(workspaceId);
    return session;
  };
  const listSessionMessages = vi.fn(
    async (input: { workspaceId: string; agentSessionId: string }) => {
      const snapshot = getSnapshot(input.workspaceId);
      const messages = snapshot.sessionMessagesById[input.agentSessionId] ?? [];
      return {
        messages,
        latestVersion: messages.reduce(
          (max, message) => Math.max(max, message.version),
          0
        ),
        hasMore: false
      };
    }
  );
  const runtime: MockAgentActivityRuntime = {
    activateSession: vi.fn(async (input) =>
      (
        agentHostApi.agentSessions.activate as (payload: {
          agentSessionId: string;
          cwd?: string;
          mode: "existing" | "new";
          openclawGatewayReady?: boolean;
          provider?: string;
          settings?: {
            model?: string | null;
            permissionMode?: string | null;
            planMode?: boolean;
            reasoningEffort?: string | null;
          };
          title?: string;
          visible?: boolean;
          workspaceId: string;
        }) => Promise<AgentHostActivateAgentSessionResult>
      )(input)
    ),
    cancelSession: async (input) => ({
      canceled: true,
      reason: "active_turn_canceled",
      session: {
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        provider: "codex",
        cwd: "",
        title: "Codex",
        status: "canceled"
      }
    }),
    createSession: async (input) => ({
      workspaceId: input.workspaceId,
      agentSessionId: input.agentSessionId ?? "session",
      provider: input.provider,
      cwd: input.cwd ?? "",
      title: input.title ?? input.provider,
      status: "ready"
    }),
    deleteSession: async () => ({ removed: true }),
    getSession: async (workspaceId, agentSessionId) => ({
      workspaceId,
      agentSessionId,
      provider: "codex",
      cwd: "",
      title: "Codex",
      status: "ready"
    }),
    getComposerOptions: async () => ({}),
    getSessionControlState: vi.fn(async (input) =>
      (
        agentHostApi.agentSessions.getState as (payload: {
          agentSessionId: string;
          workspaceId: string;
        }) => Promise<AgentHostAgentSessionState>
      )(input)
    ),
    updateSessionSettings: async (input) => ({
      agentSessionId: input.agentSessionId,
      settings: input.settings
    }),
    getSnapshot,
    listSessionMessages,
    load: async (workspaceId) => getSnapshot(workspaceId),
    retainSessionEvents: vi.fn(() => () => {}),
    sendInput: vi.fn(async (input) => ({
      ...upsertSession(input.workspaceId, input.agentSessionId, {
        status: "working"
      }),
      turnId: `turn-${input.agentSessionId}`
    })),
    setSessionPinned: async (input) => ({
      workspaceId: input.workspaceId,
      agentSessionId: input.agentSessionId,
      provider: "codex",
      cwd: "",
      title: "Codex",
      status: "ready",
      pinnedAtUnixMs: input.pinned ? Date.now() : null
    }),
    subscribeSessionEvents: () => () => {},
    unactivateSession: vi.fn(async (input) =>
      (
        agentHostApi.agentSessions.unactivate as (payload: {
          agentSessionId: string;
          workspaceId: string;
        }) => Promise<{ agentSessionId: string; buffered: boolean }>
      )(input)
    ),
    submitInteractive: async () => ({}),
    subscribe: (workspaceId, listener) => {
      let listeners = listenersByWorkspaceId.get(workspaceId);
      if (!listeners) {
        listeners = new Set();
        listenersByWorkspaceId.set(workspaceId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
      };
    },
    emitMessages: (workspaceId, agentSessionId, messages) => {
      const snapshot = getSnapshot(workspaceId);
      snapshots.set(workspaceId, {
        ...snapshot,
        sessionMessagesById: {
          ...snapshot.sessionMessagesById,
          [agentSessionId]: messages
        }
      });
      emitSnapshot(workspaceId);
    },
    setSessionStatus: (workspaceId, agentSessionId, status) => {
      upsertSession(workspaceId, agentSessionId, { status });
    }
  };
  (
    window as { agentActivityRuntime?: AgentActivityRuntime }
  ).agentActivityRuntime = runtime;
  return runtime;
}

describe("useAgentGuiBatchRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as { agentHostApi?: unknown }).agentHostApi;
    delete (window as { agentActivityRuntime?: unknown }).agentActivityRuntime;
  });

  it("includes Hermes and OpenClaw in the supported batch provider list", () => {
    expect(AGENT_GUI_BATCH_RUNNER_PROVIDERS).toEqual([
      "codex",
      "claude-code",
      "nexight",
      "hermes",
      "openclaw"
    ]);
  });

  it("creates a fresh session for each case and runs sequentially", async () => {
    const agentHostApi = installAgentHostApi();
    const { result } = renderHook(() =>
      useAgentGuiBatchRunner({
        workspaceId: "workspace-1",
        workspacePath: "/workspace/project",
        initialProviders: ["codex"]
      })
    );
    await act(async () => {
      await result.current.selectPromptFile();
    });
    expect(result.current.cases).toHaveLength(2);

    let runPromise: Promise<void> = Promise.resolve();
    await act(async () => {
      runPromise = result.current.run();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(2000);
      await runPromise;
    });

    expect(
      agentHostApi.agentActivityRuntime.activateSession
    ).toHaveBeenCalledTimes(2);
    expect(
      agentHostApi.agentActivityRuntime.activateSession.mock.calls[0]![0]
        .workspaceId
    ).toBe("workspace-1");
    expect(
      agentHostApi.agentActivityRuntime.activateSession.mock.calls.map(
        ([input]) => input.initialContent
      )
    ).toEqual([
      [{ type: "text", text: "first" }],
      [{ type: "text", text: "second" }]
    ]);
    expect(agentHostApi.agentActivityRuntime.sendInput).not.toHaveBeenCalled();
    const firstSessionId =
      agentHostApi.agentActivityRuntime.activateSession.mock.calls[0]![0]
        .agentSessionId;
    const secondSessionId =
      agentHostApi.agentActivityRuntime.activateSession.mock.calls[1]![0]
        .agentSessionId;
    expect(firstSessionId).not.toBe(secondSessionId);
    expect(result.current.results.map((item) => item.status)).toEqual([
      "completed",
      "completed"
    ]);
  });

  it("loads built-in prompt cases without opening the local file picker", () => {
    const agentHostApi = installAgentHostApi();
    const { result } = renderHook(() =>
      useAgentGuiBatchRunner({
        workspaceId: "room-1",
        workspacePath: "/workspace/project",
        initialProviders: ["codex"]
      })
    );

    act(() => {
      result.current.selectBuiltInPromptFile();
    });

    expect(agentHostApi.workspace.selectFiles).not.toHaveBeenCalled();
    expect(agentHostApi.filesystem.readFileText).not.toHaveBeenCalled();
    expect(result.current.selectedFile).toEqual({
      name: "agent-gui-batch-built-in-cases.jsonl",
      path: "packages/agent/gui/agent-gui/agentGuiBatchRunner/agentGuiBatchBuiltInCases.jsonl",
      source: "builtin"
    });
    expect(result.current.cases.map((batchCase) => batchCase.id)).toEqual([
      "quick-greeting",
      "project-overview",
      "list-key-files",
      "plan-mode-smoke"
    ]);
    expect(result.current.cases[0]).toMatchObject({
      prompt: "Greet me in one sentence.",
      title: "Quick greeting"
    });
    expect(result.current.cases[0]?.title).not.toBe("简单问候");
    expect(result.current.status).toBe("ready");
    expect(result.current.isRunnable).toBe(true);
  });

  it("loads localized built-in prompt cases", () => {
    const agentHostApi = installAgentHostApi();
    const { result } = renderHook(() =>
      useAgentGuiBatchRunner({
        locale: "zh-CN",
        workspaceId: "room-1",
        workspacePath: "/workspace/project",
        initialProviders: ["codex"]
      })
    );

    act(() => {
      result.current.selectBuiltInPromptFile();
    });

    expect(agentHostApi.workspace.selectFiles).not.toHaveBeenCalled();
    expect(result.current.cases[0]).toMatchObject({
      prompt: "请用一句话向我问好。",
      title: "简单问候"
    });
  });

  it("refreshes selected built-in cases when locale changes", () => {
    installAgentHostApi();
    const { rerender, result } = renderHook(
      ({ locale }: { locale: "en" | "zh-CN" }) =>
        useAgentGuiBatchRunner({
          locale,
          workspaceId: "room-1",
          workspacePath: "/workspace/project",
          initialProviders: ["codex"]
        }),
      { initialProps: { locale: "en" } }
    );

    act(() => {
      result.current.selectBuiltInPromptFile();
    });
    expect(result.current.cases[0]).toMatchObject({
      prompt: "Greet me in one sentence.",
      title: "Quick greeting"
    });

    rerender({ locale: "zh-CN" });

    expect(result.current.cases[0]).toMatchObject({
      prompt: "请用一句话向我问好。",
      title: "简单问候"
    });
  });

  it("deduplicates and sorts session timeline items by stable item keys", () => {
    const first = timelineItem({
      id: 2,
      eventId: "event-2",
      occurredAtUnixMs: 20
    });
    const duplicate = timelineItem({
      id: 3,
      eventId: "event-2",
      occurredAtUnixMs: 30,
      content: "updated"
    });
    const earlier = timelineItem({
      id: 1,
      eventId: "event-1",
      occurredAtUnixMs: 10
    });

    expect(
      mergeAgentGuiBatchSessionTimelineItems([first], [duplicate, earlier])
    ).toEqual([earlier, duplicate]);
  });

  it("loads session timeline using agent and provider session id candidates", async () => {
    const agentHostApi = installAgentHostApi();
    agentHostApi.agentActivityRuntime.emitMessages(
      "room-1",
      "provider-session",
      [
        {
          id: 1,
          agentSessionId: "provider-session",
          messageId: "provider-message",
          version: 1,
          role: "assistant",
          kind: "text",
          payload: { text: "hello" },
          occurredAtUnixMs: 1
        }
      ]
    );
    const { result } = renderHook(() =>
      useAgentGuiBatchRunner({
        workspaceId: "room-1",
        workspacePath: "/workspace/project",
        initialProviders: ["nexight"]
      })
    );
    const caseResult = {
      id: "case-1",
      line: 1,
      title: "Case 1",
      prompt: "hello",
      status: "completed" as const,
      provider: "nexight" as const,
      agentSessionId: "agent-session",
      providerSessionId: "provider-session"
    };

    await act(async () => {
      await result.current.loadSessionTimeline(caseResult);
    });

    expect(
      agentHostApi.agentActivityRuntime.listSessionMessages
    ).toHaveBeenCalledTimes(2);
    expect(
      agentHostApi.agentActivityRuntime.listSessionMessages.mock.calls.map(
        (call) => call[0].agentSessionId
      )
    ).toEqual(["agent-session", "provider-session"]);
    expect(
      result.current.sessionTimelines[agentGuiBatchRunCaseResultKey(caseResult)]
        ?.timelineItems
    ).toEqual([
      expect.objectContaining({ eventId: "provider-message", content: "hello" })
    ]);
  });

  it("merges live timeline events into the running case session state", async () => {
    const agentHostApi = installAgentHostApi();
    const { result } = renderHook(() =>
      useAgentGuiBatchRunner({
        workspaceId: "room-1",
        workspacePath: "/workspace/project",
        initialProviders: ["codex"]
      })
    );

    await act(async () => {
      await result.current.selectPromptFile();
    });
    await act(async () => {
      void result.current.run();
      await flushPromises();
    });

    const agentSessionId =
      agentHostApi.agentActivityRuntime.activateSession.mock.calls[0]![0]
        .agentSessionId;
    const turnId = `turn-${agentSessionId}`;

    await act(async () => {
      agentHostApi.agentActivityRuntime.emitMessages("room-1", agentSessionId, [
        {
          workspaceId: "room-1",
          agentSessionId,
          messageId: "message-1",
          id: 1,
          version: 1,
          turnId,
          role: "assistant",
          kind: "text",
          payload: { text: "done" },
          occurredAtUnixMs: 1
        }
      ]);
      agentHostApi.agentActivityRuntime.setSessionStatus(
        "room-1",
        agentSessionId,
        "completed"
      );
      await flushPromises();
    });

    expect(
      result.current.sessionTimelines[
        agentGuiBatchRunCaseResultKey({
          id: "a",
          line: 1,
          provider: "codex"
        })
      ]?.timelineItems
    ).toEqual([
      expect.objectContaining({ eventId: "message-1", content: "done" })
    ]);
  });

  it("runs every case for every selected agent", async () => {
    const agentHostApi = installAgentHostApi();
    const { result } = renderHook(() =>
      useAgentGuiBatchRunner({
        workspaceId: "room-1",
        workspacePath: "/workspace/project",
        initialProviders: ["codex"]
      })
    );

    await act(async () => {
      await result.current.selectPromptFile();
    });
    act(() => {
      result.current.toggleSelectedProvider("claude-code");
    });

    let runPromise: Promise<void> = Promise.resolve();
    await act(async () => {
      runPromise = result.current.run();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
      await runPromise;
    });

    expect(
      agentHostApi.agentActivityRuntime.activateSession
    ).toHaveBeenCalledTimes(4);
    expect(
      result.current.results.map((item) => `${item.provider}:${item.status}`)
    ).toEqual([
      "codex:completed",
      "codex:completed",
      "claude-code:completed",
      "claude-code:completed"
    ]);
  });

  it("marks pending interactive state as blocked and stops the batch", async () => {
    const getState = vi.fn(async (payload: { agentSessionId: string }) => ({
      workspaceId: "room-1",
      agentSessionId: payload.agentSessionId,
      provider: "codex",
      status: "waiting",
      updatedAtUnixMs: Date.now(),
      pendingInteractive: {
        kind: "approval",
        requestId: "request-1",
        status: "pending"
      }
    }));
    const agentHostApi = installAgentHostApi({ getState });
    const { result } = renderHook(() =>
      useAgentGuiBatchRunner({
        workspaceId: "room-1",
        workspacePath: "/workspace/project",
        initialProviders: ["codex"]
      })
    );

    await act(async () => {
      await result.current.selectPromptFile();
    });

    let runPromise: Promise<void> = Promise.resolve();
    await act(async () => {
      runPromise = result.current.run();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await runPromise;
    });

    expect(
      agentHostApi.agentActivityRuntime.activateSession
    ).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("blocked");
    expect(result.current.results[0]!.status).toBe("blocked");
    expect(result.current.results[1]!.status).toBe("pending");
  });
});

function timelineItem(
  overrides: Partial<AgentHostWorkspaceAgentTimelineItem> = {}
): AgentHostWorkspaceAgentTimelineItem {
  return {
    id: 1,
    workspaceId: "room-1",
    agentSessionId: "agent-session",
    eventId: "event-1",
    actorType: "agent",
    actorId: "agent",
    itemType: "message",
    role: "assistant",
    content: "content",
    occurredAtUnixMs: 1,
    createdAtUnixMs: 1,
    ...overrides
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
