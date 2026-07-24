import assert from "node:assert/strict";
import test from "node:test";
import { createAgentActivitySnapshotProjector } from "./agentActivitySnapshot.projector.ts";
import {
  createInitialAgentSessionEngineState,
  rootEngineReducer
} from "./rootReducer.ts";
import type { AgentActivitySession } from "../types.ts";

test("projects canonical engine state and preserves the snapshot reference", () => {
  const project = createAgentActivitySnapshotProjector("workspace-1");
  let state = createInitialAgentSessionEngineState();
  const empty = project(state);
  assert.equal(project(state), empty);

  state = rootEngineReducer(state, {
    type: "session/snapshotReceived",
    sessions: [session()]
  }).state;
  const populated = project(state);
  assert.notEqual(populated, empty);
  assert.equal(project(state), populated);
  assert.equal(populated.sessions[0]?.activeTurn?.turnId, "turn-1");
  assert.equal(populated.sessions[0]?.latestTurn?.turnId, "turn-1");
  assert.equal(populated.sessions[0]?.latestTurnInteractions.length, 1);
  assert.equal(populated.sessions[0]?.pendingInteractions.length, 1);
});

test("reuses expensive projections when unrelated engine slices change", () => {
  const project = createAgentActivitySnapshotProjector("workspace-1");
  const populatedState = rootEngineReducer(
    createInitialAgentSessionEngineState(),
    {
      type: "session/snapshotReceived",
      sessions: [session()]
    }
  ).state;
  const populated = project(populatedState);
  const reconcileOnlyState = {
    ...populatedState,
    sessionReconcile: { ...populatedState.sessionReconcile }
  };

  const reconciled = project(reconcileOnlyState);

  assert.notEqual(reconciled, populated);
  assert.equal(reconciled.sessions, populated.sessions);
  assert.equal(reconciled.sessionMessagesById, populated.sessionMessagesById);
  assert.equal(
    reconciled.sessionMessageWindowsById,
    populated.sessionMessageWindowsById
  );
  assert.equal(
    reconciled.composerOptionsByTargetKey,
    populated.composerOptionsByTargetKey
  );
  assert.equal(
    reconciled.composerOptionsLoadStatusByTargetKey,
    populated.composerOptionsLoadStatusByTargetKey
  );
});

function session(): AgentActivitySession {
  const turn = {
    agentSessionId: "session-1",
    completedCommand: null,
    error: null,
    fileChanges: null,
    outcome: null,
    origin: "user_prompt" as const,
    phase: "waiting" as const,
    settledAtUnixMs: null,
    startedAtUnixMs: 10,
    turnId: "turn-1",
    updatedAtUnixMs: 20
  };
  const interaction = {
    agentSessionId: "session-1",
    createdAtUnixMs: 15,
    input: {},
    kind: "approval" as const,
    metadata: {},
    requestId: "request-1",
    status: "pending" as const,
    toolName: "Bash",
    turnId: "turn-1",
    updatedAtUnixMs: 20
  };
  return {
    activeTurn: turn,
    activeTurnId: turn.turnId,
    agentSessionId: "session-1",
    kind: "root",
    rootAgentSessionId: null,
    rootTurnId: null,
    parentAgentSessionId: null,
    parentTurnId: null,
    parentToolCallId: null,
    agentTargetId: "agent-1",
    capabilities: null,
    createdAtUnixMs: 1,
    cwd: "/workspace",
    endedAtUnixMs: null,
    goal: null,
    imported: false,
    lastEventUnixMs: 20,
    latestTurn: turn,
    latestTurnInteractions: [interaction],
    messageVersion: 0,
    pendingInteractions: [interaction],
    permissionConfig: { configurable: false, modes: [] },
    pinnedAtUnixMs: null,
    provider: "codex",
    providerSessionId: null,
    resumable: true,
    settings: {},
    startedAtUnixMs: 1,
    title: "Session",
    tuttiModeActivation: null,
    updatedAtUnixMs: 20,
    usage: null,
    visible: true,
    workspaceId: "workspace-1"
  };
}
