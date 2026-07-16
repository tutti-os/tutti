import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentActivitySession } from "./sessionNormalization.ts";

test("normalizes a transport session into the complete canonical contract", () => {
  const session = normalizeAgentActivitySession({
    ...{
      activeTurnId: null,
      latestTurnInteractions: [],
      pendingInteractions: []
    },
    agentSessionId: "session-1",
    cwd: "/workspace",
    provider: "codex",
    title: "Session",
    tuttiModeActivation: null,
    updatedAtUnixMs: 42,
    workspaceId: "workspace-1"
  });

  assert.deepEqual(session, {
    activeTurn: null,
    activeTurnId: null,
    agentSessionId: "session-1",
    agentTargetId: null,
    capabilities: null,
    createdAtUnixMs: 0,
    cwd: "/workspace",
    endedAtUnixMs: null,
    goal: null,
    imported: false,
    kind: "root",
    lastEventUnixMs: 42,
    latestTurn: null,
    latestTurnInteractions: [],
    messageVersion: 0,
    pendingInteractions: [],
    parentAgentSessionId: null,
    parentToolCallId: null,
    parentTurnId: null,
    permissionConfig: { configurable: false, modes: [] },
    pinnedAtUnixMs: null,
    provider: "codex",
    providerSessionId: null,
    resumable: false,
    rootAgentSessionId: null,
    rootTurnId: null,
    settings: {},
    startedAtUnixMs: 0,
    title: "Session",
    tuttiModeActivation: null,
    updatedAtUnixMs: 42,
    usage: null,
    visible: true,
    workspaceId: "workspace-1"
  });
});
