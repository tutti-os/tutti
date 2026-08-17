import {
  selectSessionMessages,
  selectSessionMessageWindow,
  type AgentActivityMessagePage
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import {
  createTestAgentSessionEngine,
  type TestEngineCommandHandler
} from "./shared/testing/createTestAgentSessionEngine";
import {
  createAgentConversationMessageController,
  type AgentConversationMessagePageInput
} from "./agentConversationMessageController";

describe("createAgentConversationMessageController", () => {
  it("routes initial and latest hydration through Engine reconcile commands", async () => {
    const execute = vi.fn<TestEngineCommandHandler["execute"]>(async () => ({
      affectedSessionIds: [],
      appliedMessages: [],
      session: null,
      status: "applied"
    }));
    const engine = createTestAgentSessionEngine("workspace-1", { execute });
    const controller = createController({ engine });

    controller.setActiveSession("session-1");
    controller.requestInitial("session-1");
    controller.requestLatest("session-1");

    await vi.waitFor(() => {
      expect(
        execute.mock.calls.filter(
          ([command]) => command.type === "session/reconcile"
        )
      ).toHaveLength(2);
    });
    const reconcileCommands = execute.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === "session/reconcile");
    expect(reconcileCommands).toEqual([
      expect.objectContaining({
        agentSessionId: "session-1",
        scope: "state_and_messages"
      }),
      expect.objectContaining({
        agentSessionId: "session-1",
        scope: "messages"
      })
    ]);

    controller.dispose();
    engine.dispose();
  });

  it("treats repeated initial hydration as idempotent while reconcile is pending", async () => {
    type CommandResult = Awaited<
      ReturnType<TestEngineCommandHandler["execute"]>
    >;
    let resolveExecute: (result: CommandResult) => void = () => {};
    const execute = vi.fn<TestEngineCommandHandler["execute"]>(
      () =>
        new Promise((resolve) => {
          resolveExecute = resolve;
        })
    );
    const engine = createTestAgentSessionEngine("workspace-1", { execute });
    const controller = createController({ engine });

    controller.requestInitial("session-1");
    controller.requestInitial("session-1");

    await vi.waitFor(() => {
      expect(
        execute.mock.calls.filter(
          ([command]) => command.type === "session/reconcile"
        )
      ).toHaveLength(1);
    });
    resolveExecute({
      affectedSessionIds: [],
      appliedMessages: [],
      session: null,
      status: "applied"
    });

    controller.dispose();
    engine.dispose();
  });

  it("loads older history only from the authoritative Engine window", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    const listSessionMessages = vi.fn(async () =>
      messagePage([message(1)], false)
    );
    const controller = createController({ engine, listSessionMessages });
    controller.setActiveSession("session-1");

    engine.dispatch({
      messages: [message(446)],
      type: "message/snapshotReceived",
      workspaceId: "workspace-1"
    });
    await controller.loadOlder();
    expect(listSessionMessages).not.toHaveBeenCalled();

    engine.dispatch({
      messages: [],
      sessionMessageWindows: [
        {
          agentSessionId: "session-1",
          hasOlderMessages: true,
          oldestLoadedVersion: 446
        }
      ],
      type: "message/snapshotReceived",
      workspaceId: "workspace-1"
    });
    await controller.loadOlder();

    expect(listSessionMessages).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      beforeVersion: 446,
      limit: 100,
      order: "desc",
      signal: expect.any(AbortSignal),
      workspaceId: "workspace-1"
    });
    expect(
      selectSessionMessages(engine.getSnapshot(), "session-1").map(
        (item) => item.version
      )
    ).toEqual([1, 446]);
    expect(
      selectSessionMessageWindow(engine.getSnapshot(), "session-1")
    ).toEqual({
      hasOlderMessages: false,
      oldestLoadedVersion: 1
    });

    controller.dispose();
    engine.dispose();
  });

  it("deduplicates an in-flight cursor and permits retry after failure", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    let rejectFirst: ((error: unknown) => void) | null = null;
    const listSessionMessages = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AgentActivityMessagePage>((_resolve, reject) => {
            rejectFirst = reject;
          })
      )
      .mockResolvedValueOnce(messagePage([message(1)], false));
    const controller = createController({ engine, listSessionMessages });
    controller.setActiveSession("session-1");
    setOlderWindow(engine, 5);

    const first = controller.loadOlder();
    const duplicate = controller.loadOlder();
    expect(listSessionMessages).toHaveBeenCalledTimes(1);
    rejectFirst!(new Error("temporary failure"));
    await first;
    await duplicate;
    expect(controller.getSnapshot().olderPagePhase).toBe("error");

    await controller.loadOlder();
    expect(listSessionMessages).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().olderPagePhase).toBe("idle");

    controller.dispose();
    engine.dispose();
  });

  it("fences an older page after the active Session changes", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    let resolvePage: ((page: AgentActivityMessagePage) => void) | null = null;
    let requestSignal!: AbortSignal;
    const listSessionMessages = vi.fn(
      (input: AgentConversationMessagePageInput) =>
        new Promise<AgentActivityMessagePage>((resolve) => {
          requestSignal = input.signal;
          resolvePage = resolve;
        })
    );
    const controller = createController({ engine, listSessionMessages });
    controller.setActiveSession("session-1");
    setOlderWindow(engine, 5);

    const request = controller.loadOlder();
    controller.setActiveSession("session-2");
    expect(requestSignal.aborted).toBe(true);
    resolvePage!(messagePage([message(1)], false));
    await request;

    expect(selectSessionMessages(engine.getSnapshot(), "session-1")).toEqual(
      []
    );
    expect(controller.getSnapshot()).toEqual({
      agentSessionId: "session-2",
      error: null,
      olderPagePhase: "idle"
    });

    controller.dispose();
    engine.dispose();
  });

  it("retains synchronization only for the active Session", () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    const releases: string[] = [];
    const ensureSessionSynchronized = vi.fn(
      ({ agentSessionId }: { agentSessionId: string }) =>
        () => {
          releases.push(agentSessionId);
        }
    );
    const controller = createController({
      engine,
      ensureSessionSynchronized
    });

    controller.setActiveSession("session-1");
    controller.setActiveSession("session-1");
    controller.setActiveSession("session-2");
    controller.setActiveSession(null);
    controller.setActiveSession("session-3");
    controller.dispose();

    expect(ensureSessionSynchronized.mock.calls).toEqual([
      [
        expect.objectContaining({
          agentSessionId: "session-1",
          workspaceId: "workspace-1"
        })
      ],
      [
        expect.objectContaining({
          agentSessionId: "session-2",
          workspaceId: "workspace-1"
        })
      ],
      [
        expect.objectContaining({
          agentSessionId: "session-3",
          workspaceId: "workspace-1"
        })
      ]
    ]);
    expect(releases).toEqual(["session-1", "session-2", "session-3"]);

    engine.dispose();
  });

  it("rejects a stale page when the host focus changes before synchronization", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    let focusedSessionId = "session-1";
    let resolvePage: ((page: AgentActivityMessagePage) => void) | null = null;
    const controller = createController({
      engine,
      isAvailable: (agentSessionId) =>
        !agentSessionId || agentSessionId === focusedSessionId,
      listSessionMessages: () =>
        new Promise<AgentActivityMessagePage>((resolve) => {
          resolvePage = resolve;
        })
    });
    controller.setActiveSession("session-1");
    setOlderWindow(engine, 5);

    const request = controller.loadOlder();
    focusedSessionId = "session-2";
    resolvePage!(messagePage([message(1)], false));
    await request;

    expect(selectSessionMessages(engine.getSnapshot(), "session-1")).toEqual(
      []
    );

    controller.dispose();
    engine.dispose();
  });
});

function createController(input: {
  engine: ReturnType<typeof createTestAgentSessionEngine>;
  ensureSessionSynchronized?: Parameters<
    typeof createAgentConversationMessageController
  >[0]["ensureSessionSynchronized"];
  isAvailable?: (agentSessionId?: string | null) => boolean;
  listSessionMessages?: (
    input: AgentConversationMessagePageInput
  ) => Promise<AgentActivityMessagePage>;
}) {
  return createAgentConversationMessageController({
    engine: input.engine,
    ensureSessionSynchronized: input.ensureSessionSynchronized,
    isAvailable: input.isAvailable ?? (() => true),
    listSessionMessages:
      input.listSessionMessages ??
      (async () => ({ hasMore: false, latestVersion: 0, messages: [] })),
    workspaceId: "workspace-1"
  });
}

function setOlderWindow(
  engine: ReturnType<typeof createTestAgentSessionEngine>,
  oldestLoadedVersion: number
): void {
  engine.dispatch({
    messages: [],
    sessionMessageWindows: [
      {
        agentSessionId: "session-1",
        hasOlderMessages: true,
        oldestLoadedVersion
      }
    ],
    type: "message/snapshotReceived",
    workspaceId: "workspace-1"
  });
}

function message(version: number) {
  return {
    agentSessionId: "session-1",
    kind: "text",
    messageId: `message-${version}`,
    occurredAtUnixMs: version,
    payload: {},
    role: "assistant",
    sequence: version,
    turnId: "turn-1",
    version
  };
}

function messagePage(
  messages: ReturnType<typeof message>[],
  hasMore: boolean
): AgentActivityMessagePage {
  return {
    hasMore,
    latestVersion: messages.at(-1)?.version ?? 0,
    messages
  };
}
