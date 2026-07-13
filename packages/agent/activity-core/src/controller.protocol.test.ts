import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivityAdapter } from "./adapter.ts";
import { createAgentActivityController } from "./controller.ts";
import { normalizeAgentActivitySession } from "./sessionNormalization.ts";
import type {
  AgentActivitySession,
  AgentActivityUpdatedEvent
} from "./types.ts";

test("controller loads canonical sessions and caches listed messages", async () => {
  const controller = createAgentActivityController({
    adapter: adapter({
      listSessionMessages: async () => ({
        hasMore: false,
        latestVersion: 2,
        messages: [message("message-2", 2)]
      }),
      listSessions: async () => ({ sessions: [session()] })
    }),
    workspaceId: "workspace-1"
  });

  await controller.load();
  await controller.listSessionMessages({ agentSessionId: "session-1" });

  assert.equal(
    controller.getSnapshot().sessions[0]?.agentSessionId,
    "session-1"
  );
  assert.deepEqual(
    controller
      .getSnapshot()
      .sessionMessagesById["session-1"]?.map((item) => item.messageId),
    ["message-2"]
  );
});

test("controller applies generated message events without retaining storage ids", () => {
  const controller = loadedController();
  const event: AgentActivityUpdatedEvent = {
    agentSessionId: "session-1",
    workspaceId: "workspace-1",
    eventType: "message_update",
    data: {
      acceptedCount: 1,
      agentSessionId: "session-1",
      eventType: "message_update",
      latestVersion: 3,
      messages: [
        {
          agentSessionId: "session-1",
          kind: "text",
          messageId: "message-3",
          occurredAtUnixMs: 30,
          payload: { text: "done" },
          role: "assistant",
          turnId: "turn-1",
          version: 3
        }
      ],
      workspaceId: "workspace-1"
    }
  };

  const result = controller.applyActivityUpdatedEvent(event);

  assert.equal(result.applied, true);
  assert.equal(result.messages[0]?.messageId, "message-3");
  assert.equal(result.messages[0]?.version, 3);
  assert.equal(result.messages[0]?.occurredAtUnixMs, 30);
});

test("controller updates canonical turn and interaction entities independently", () => {
  const controller = loadedController();
  const turnEvent: AgentActivityUpdatedEvent = {
    agentSessionId: "session-1",
    workspaceId: "workspace-1",
    eventType: "turn_update",
    data: {
      activeTurnId: "turn-1",
      agentSessionId: "session-1",
      eventType: "turn_update",
      occurredAtUnixMs: 20,
      turn: {
        agentSessionId: "session-1",
        completedCommand: null,
        error: null,
        fileChanges: null,
        outcome: "completed",
        phase: "running",
        settledAtUnixMs: null,
        startedAtUnixMs: 10,
        turnId: "turn-1",
        updatedAtUnixMs: 20
      },
      workspaceId: "workspace-1"
    }
  };
  const interactionEvent: AgentActivityUpdatedEvent = {
    agentSessionId: "session-1",
    workspaceId: "workspace-1",
    eventType: "interaction_update",
    data: {
      agentSessionId: "session-1",
      eventType: "interaction_update",
      interaction: {
        agentSessionId: "session-1",
        createdAtUnixMs: 21,
        input: null,
        kind: "question",
        metadata: null,
        output: null,
        requestId: "request-1",
        status: "pending",
        turnId: "turn-1",
        toolName: null,
        updatedAtUnixMs: 21
      },
      occurredAtUnixMs: 21,
      workspaceId: "workspace-1"
    }
  };

  controller.applyActivityUpdatedEvent(turnEvent);
  controller.applyActivityUpdatedEvent(interactionEvent);

  const updated = controller.getSnapshot().sessions[0];
  assert.equal(updated?.activeTurn?.phase, "running");
  assert.equal(updated?.pendingInteractions?.[0]?.requestId, "request-1");
});

function loadedController() {
  const controller = createAgentActivityController({
    adapter: adapter(),
    workspaceId: "workspace-1"
  });
  controller.upsertSession(session());
  return controller;
}

function session(): AgentActivitySession {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId: "session-1",
    cwd: "/workspace",
    provider: "codex",
    title: "Session",
    updatedAtUnixMs: 1,
    workspaceId: "workspace-1"
  });
}

function message(
  messageId: string,
  version: number,
  occurredAtUnixMs = version
) {
  return {
    agentSessionId: "session-1",
    kind: "text",
    messageId,
    occurredAtUnixMs,
    payload: { text: "done" },
    role: "assistant",
    turnId: "turn-1",
    version,
    workspaceId: "workspace-1"
  };
}

function adapter(
  overrides: Partial<AgentActivityAdapter> = {}
): AgentActivityAdapter {
  const unsupported = async (): Promise<never> => {
    throw new Error("unsupported test adapter operation");
  };
  return {
    createSession: unsupported,
    deleteSession: unsupported,
    goalControl: unsupported,
    listComposerOptions: unsupported,
    listSessionMessages: async () => ({
      hasMore: false,
      latestVersion: 0,
      messages: []
    }),
    listSessions: async () => ({ sessions: [] }),
    loadComposerOptions: unsupported,
    renameSession: unsupported,
    sendInput: unsupported,
    submitInteractive: unsupported,
    subscribeSessionEvents: async () => () => {},
    ...overrides
  } as AgentActivityAdapter;
}
