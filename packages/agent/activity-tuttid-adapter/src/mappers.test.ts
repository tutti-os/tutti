import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceAgentSessionGoalControlResponse,
  WorkspaceAgentSession,
  WorkspaceAgentSessionMessage
} from "@tutti-os/client-tuttid-ts";
import {
  agentActivityGoalControlResultFromTuttid,
  agentActivityMessageFromTuttidMessage,
  agentActivitySessionFromTuttidSession,
  agentActivityTuttiModeActivationFromTuttid
} from "./index.ts";

test("goal control mapping preserves operation evidence and explicit clear", () => {
  const response = {
    goal: null,
    operationId: " operation-1 ",
    session: {
      ...createSession(),
      goal: {
        objective: "stale session projection",
        status: "active"
      }
    },
    state: {
      desired: null,
      lastEvidence: { source: "goal-control" },
      observed: null,
      observedAtUnixMs: null,
      pendingOperationId: null,
      revision: 3,
      syncStatus: "synced",
      tombstoned: true,
      updatedAtUnixMs: 10
    }
  } satisfies WorkspaceAgentSessionGoalControlResponse;

  const result = agentActivityGoalControlResultFromTuttid(
    "workspace-1",
    response,
    { currentUserId: "account-user-1" }
  );

  assert.equal(result.goal, null);
  assert.equal(result.operationId, "operation-1");
  assert.deepEqual(result.state, response.state);
  assert.notEqual(result.state?.lastEvidence, response.state.lastEvidence);
});

test("session mapping requires and preserves the host-owned user identity", () => {
  const session = agentActivitySessionFromTuttidSession(
    "workspace-1",
    createSession(),
    { currentUserId: "account-user-1" }
  );
  assert.equal(session.userId, "account-user-1");
  assert.equal(session.messageVersion, 7);
  assert.equal(session.goalSyncState, null);
  assert.deepEqual(session.forkedFrom, {
    forkedAtUnixMs: 9,
    operationId: "operation-1",
    sourceAgentSessionId: "source-1",
    sourceTurnId: "turn-1",
    targetTurnId: "target-turn-1"
  });
});

test("session mapping preserves durable Goal synchronization evidence", () => {
  const session = agentActivitySessionFromTuttidSession(
    "workspace-1",
    {
      ...createSession(),
      goalSyncState: {
        executionPending: true,
        pendingOperationId: " goal-operation-1 ",
        revision: 4,
        syncStatus: "applying"
      }
    },
    { currentUserId: "account-user-1" }
  );

  assert.deepEqual(session.goalSyncState, {
    executionPending: true,
    pendingOperationId: "goal-operation-1",
    revision: 4,
    syncStatus: "applying"
  });
});

test("session mapping rejects malformed Goal synchronization evidence", () => {
  for (const goalSyncState of [
    {
      executionPending: false,
      pendingOperationId: 42,
      revision: 1,
      syncStatus: "applying"
    },
    {
      executionPending: false,
      pendingOperationId: null,
      revision: -1,
      syncStatus: "applying"
    },
    {
      executionPending: false,
      pendingOperationId: null,
      revision: 1,
      syncStatus: "future"
    },
    { pendingOperationId: null, revision: 1, syncStatus: "synced" }
  ]) {
    assert.throws(
      () =>
        agentActivitySessionFromTuttidSession(
          "workspace-1",
          {
            ...createSession(),
            goalSyncState
          } as unknown as WorkspaceAgentSession,
          { currentUserId: "account-user-1" }
        ),
      /goalSyncState is invalid/
    );
  }
});

test("session mapping rejects an invalid message cursor", () => {
  assert.throws(
    () =>
      agentActivitySessionFromTuttidSession(
        "workspace-1",
        { ...createSession(), messageVersion: -1 },
        { currentUserId: "account-user-1" }
      ),
    /messageVersion must be a non-negative safe integer/
  );
});

test("session mapping rejects missing protocol-v2 fields", () => {
  for (const field of [
    "activeTurnId",
    "forkedFrom",
    "latestTurnInteractions",
    "lifecycleCapabilities",
    "pendingInteractions",
    "messageVersion",
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

test("Tutti mode activation mapping reads the legacy single-axis response", () => {
  const activation = agentActivityTuttiModeActivationFromTuttid({
    agentSessionId: "session-1",
    createdAtUnixMs: 1,
    currentRevision: {
      activationId: "activation-1",
      createdAtUnixMs: 2,
      id: "revision-1",
      orchestrationIntensity: 73,
      revision: 1,
      source: "slash_command",
      status: "active"
    },
    id: "activation-1",
    status: "active",
    updatedAtUnixMs: 2,
    workspaceId: "workspace-1"
  });

  assert.equal(activation.currentRevision.effect, 73);
  assert.equal(activation.currentRevision.speed, 50);
  assert.equal(activation.currentRevision.orchestrationIntensity, 73);
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
    goalSyncState: null,
    id: "session-1",
    imported: false,
    kind: "root",
    latestTurn: null,
    latestTurnInteractions: [],
    messageVersion: 7,
    lifecycleCapabilities: { fork: false, forkThroughTurn: false },
    forkedFrom: {
      forkedAtUnixMs: 9,
      operationId: "operation-1",
      sourceAgentSessionId: "source-1",
      sourceTurnId: "turn-1",
      targetTurnId: "target-turn-1"
    },
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
