import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
  createAgentSessionEngine,
  type AgentActivityTurn,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import { resolveWorkspaceAgentStatusPetMood } from "./workspaceAgentStatusPetMood.ts";

test("workspace agent status pet mood is idle without active work", () => {
  const engine = createEngine();
  assert.equal(
    resolveWorkspaceAgentStatusPetMood(engine.getSnapshot()),
    "idle"
  );
  dispatchSession(engine, "session-1");
  dispatchTurn(engine, "settled", "completed");
  assert.equal(
    resolveWorkspaceAgentStatusPetMood(engine.getSnapshot()),
    "idle"
  );
});

test("workspace agent status pet mood prioritizes canonical interaction and turn states", () => {
  const waiting = createEngine();
  dispatchSession(waiting, "session-1", "turn-1");
  dispatchTurn(waiting, "waiting");
  waiting.dispatch({
    type: "interaction/upserted",
    interaction: {
      agentSessionId: "session-1",
      createdAtUnixMs: 2,
      kind: "question",
      requestId: "request-1",
      status: "pending",
      turnId: "turn-1",
      updatedAtUnixMs: 2
    }
  });
  assert.equal(
    resolveWorkspaceAgentStatusPetMood(waiting.getSnapshot()),
    "waiting"
  );

  const failed = createEngine();
  dispatchSession(failed, "session-1");
  dispatchTurn(failed, "settled", "failed");
  assert.equal(
    resolveWorkspaceAgentStatusPetMood(failed.getSnapshot()),
    "failed"
  );

  const running = createEngine();
  dispatchSession(running, "session-1", "turn-1");
  dispatchTurn(running, "running");
  assert.equal(
    resolveWorkspaceAgentStatusPetMood(running.getSnapshot()),
    "running"
  );
});

test("workspace agent status pet mood shows review for an engine-owned activation", () => {
  const engine = createEngine();
  engine.dispatch({
    type: "activation/requested",
    agentSessionId: "session-new",
    agentTargetId: "target-1",
    clientSubmitId: "submit-new",
    content: [],
    cwd: "/workspace",
    expiresAtUnixMs: 30_000,
    mode: "new",
    requestedAtUnixMs: 1,
    requestId: "activation-1",
    title: "New session",
    workspaceId: "workspace-1"
  });
  assert.equal(
    resolveWorkspaceAgentStatusPetMood(engine.getSnapshot()),
    "review"
  );
});

function createEngine(): AgentSessionEngine {
  return createAgentSessionEngine({
    clock: { nowUnixMs: () => 1 },
    commandPort: { execute: () => new Promise(() => {}) },
    identity: {
      origin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
      workspaceId: "workspace-1"
    },
    scheduler: {
      schedule: () => ({ cancel() {} })
    }
  });
}

function dispatchSession(
  engine: AgentSessionEngine,
  agentSessionId: string,
  activeTurnId: string | null = null
): void {
  engine.dispatch({
    type: "session/upserted",
    session: {
      agentSessionId,
      activeTurnId,
      cwd: "/workspace",
      provider: "codex",
      title: "Session",
      workspaceId: "workspace-1"
    }
  });
}

function dispatchTurn(
  engine: AgentSessionEngine,
  phase: AgentActivityTurn["phase"],
  outcome?: AgentActivityTurn["outcome"]
): void {
  engine.dispatch({
    type: "turn/upserted",
    turn: {
      agentSessionId: "session-1",
      ...(outcome ? { outcome } : {}),
      phase,
      startedAtUnixMs: 1,
      ...(phase === "settled" ? { settledAtUnixMs: 2 } : {}),
      turnId: "turn-1",
      updatedAtUnixMs: 2
    }
  });
}
