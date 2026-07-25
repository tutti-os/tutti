import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceAgentSession,
  WorkspaceAgentSessionMessage
} from "@tutti-os/client-tuttid-ts";
import {
  agentActivityMessageFromTuttidMessage,
  agentActivitySessionFromTuttidSession
} from "./index.ts";

test("session mapping requires and preserves the host-owned user identity", () => {
  const session = agentActivitySessionFromTuttidSession(
    "workspace-1",
    createSession(),
    { currentUserId: "account-user-1" }
  );
  assert.equal(session.userId, "account-user-1");
});

test("session mapping rejects missing protocol-v2 fields", () => {
  for (const field of [
    "activeTurnId",
    "latestTurnInteractions",
    "pendingInteractions",
    "railSectionKey",
    "tuttiModeActivation"
  ] as const) {
    const malformed = { ...createSession() } as Record<string, unknown>;
    delete malformed[field];
    assert.throws(
      () =>
        agentActivitySessionFromTuttidSession(
          "workspace-1",
          malformed as WorkspaceAgentSession,
          { currentUserId: "account-user-1" }
        ),
      new RegExp(`Protocol v2 contract error:.*${field}`)
    );
  }
});

test("message mapping preserves durable sequence and normalizes timestamps", () => {
  const message = agentActivityMessageFromTuttidMessage("workspace-1", {
    agentSessionId: "session-1",
    createdAtUnixMs: 100,
    kind: "text",
    messageId: "message-1",
    occurredAtUnixMs: 0,
    payload: { text: "hello" },
    role: "assistant",
    sequence: 42,
    turnId: "turn-1",
    version: 7
  } satisfies WorkspaceAgentSessionMessage);
  assert.equal(message.sequence, 42);
  assert.equal(message.occurredAtUnixMs, 100);
});

test("message mapping preserves session-level ownership and trims turn ids", () => {
  const sessionLevel = agentActivityMessageFromTuttidMessage("workspace-1", {
    agentSessionId: "session-1",
    kind: "text",
    messageId: "message-1",
    occurredAtUnixMs: 1,
    role: "assistant",
    sequence: 1,
    turnId: null,
    version: 1
  } satisfies WorkspaceAgentSessionMessage);
  const turnOwned = agentActivityMessageFromTuttidMessage("workspace-1", {
    agentSessionId: "session-1",
    kind: "text",
    messageId: "message-2",
    occurredAtUnixMs: 2,
    role: "assistant",
    sequence: 2,
    turnId: "  turn-1  ",
    version: 2
  } satisfies WorkspaceAgentSessionMessage);

  assert.equal(sessionLevel.turnId, null);
  assert.equal(turnOwned.turnId, "turn-1");
});

function createSession(): WorkspaceAgentSession {
  return {
    activeTurn: null,
    activeTurnId: null,
    agentTargetId: null,
    capabilities: null,
    createdAtUnixMs: 1,
    cwd: "/",
    endedAtUnixMs: null,
    goal: null,
    id: "session-1",
    imported: false,
    kind: "root",
    latestTurn: null,
    latestTurnInteractions: [],
    parentAgentSessionId: null,
    parentToolCallId: null,
    parentTurnId: null,
    pendingInteractions: [],
    permissionConfig: { configurable: false, modes: [] },
    pinnedAtUnixMs: null,
    provider: "codex",
    providerSessionId: null,
    railSectionKey: "conversations",
    resumable: true,
    rootAgentSessionId: null,
    rootTurnId: null,
    settings: {},
    title: "Session",
    tuttiModeActivation: null,
    updatedAtUnixMs: 2,
    usage: null,
    visible: true
  };
}
