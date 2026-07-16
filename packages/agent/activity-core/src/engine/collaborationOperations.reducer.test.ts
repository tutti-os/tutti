import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialAgentSessionEngineState,
  rootEngineReducer
} from "./rootReducer.ts";
import { createAgentSessionEngine } from "./createAgentSessionEngine.ts";
import { dispatchCollaborationOperation } from "./collaborationOperations.dispatch.ts";
import { selectCollaborationOperation } from "./collaborationOperations.selectors.ts";
import { AGENT_SESSION_ENGINE_LOCAL_ORIGIN } from "./types.ts";

test("collaboration operations cross the engine command port and settle in engine state", () => {
  const requested = rootEngineReducer(createInitialAgentSessionEngineState(), {
    input: {
      agentSessionId: "session-1",
      contextScope: "recent",
      mode: "delegate",
      question: "review this",
      targetAgentTargetId: "workspace-agent:reviewer",
      workspaceId: "workspace-1"
    },
    requestId: "request-1",
    type: "collaboration/startRequested"
  });

  assert.deepEqual(requested.commands, [
    {
      commandId: "collaboration:start:request-1",
      correlationId: "request-1",
      input: {
        agentSessionId: "session-1",
        contextScope: "recent",
        mode: "delegate",
        question: "review this",
        targetAgentTargetId: "workspace-agent:reviewer",
        workspaceId: "workspace-1"
      },
      timeoutMs: 30_000,
      type: "collaboration/start"
    }
  ]);
  assert.equal(
    selectCollaborationOperation(requested.state, "request-1")?.status,
    "inFlight"
  );

  const settled = rootEngineReducer(requested.state, {
    commandId: "collaboration:start:request-1",
    commandType: "collaboration/start",
    correlationId: "request-1",
    outcome: "succeeded",
    type: "engine/commandResult",
    value: {
      adoption: "pending",
      attempt: 1,
      id: "run-1",
      mode: "delegate",
      status: "running",
      triggerSource: "user",
      workspaceId: "workspace-1"
    }
  });

  const operation = selectCollaborationOperation(settled.state, "request-1");
  assert.equal(operation?.status, "succeeded");
  assert.equal(operation?.result?.id, "run-1");
});

test("collaboration timeout remains unknown until durable state reconciles", () => {
  const requested = rootEngineReducer(createInitialAgentSessionEngineState(), {
    input: { runId: "run-1", workspaceId: "workspace-1" },
    requestId: "retry-1",
    type: "collaboration/retryRequested"
  });
  const timedOut = rootEngineReducer(requested.state, {
    commandId: "collaboration:retry:retry-1",
    commandType: "collaboration/retry",
    correlationId: "retry-1",
    outcome: "timedOut",
    type: "engine/commandResult"
  });

  assert.equal(
    selectCollaborationOperation(timedOut.state, "retry-1")?.status,
    "unknown"
  );
});

test("collaboration dispatcher resolves from engine state and dismisses the terminal record", async () => {
  const engine = collaborationTestEngine(async (command) => {
    assert.equal(command.type, "collaboration/start");
    return {
      adoption: "not_applicable",
      attempt: 1,
      id: "run-1",
      mode: "handoff",
      status: "running",
      triggerSource: "user",
      workspaceId: "workspace-1"
    };
  });

  const run = await dispatchCollaborationOperation(engine, {
    input: {
      agentSessionId: "session-1",
      contextScope: "recent",
      mode: "handoff",
      question: "continue",
      targetAgentTargetId: "workspace-agent:target",
      workspaceId: "workspace-1"
    },
    requestId: "handoff-1",
    type: "collaboration/startRequested"
  });

  assert.equal(run.id, "run-1");
  assert.equal(
    selectCollaborationOperation(engine.getSnapshot(), "handoff-1"),
    null
  );
  engine.dispose();
});

test("collaboration dispatcher rejects command failure and dismisses the terminal record", async () => {
  const engine = collaborationTestEngine(async () => {
    throw new Error("provider unavailable");
  });

  await assert.rejects(
    dispatchCollaborationOperation(engine, {
      input: { runId: "run-1", workspaceId: "workspace-1" },
      requestId: "retry-1",
      type: "collaboration/retryRequested"
    }),
    /provider unavailable/
  );
  assert.equal(
    selectCollaborationOperation(engine.getSnapshot(), "retry-1"),
    null
  );
  engine.dispose();
});

function collaborationTestEngine(
  execute: Parameters<
    typeof createAgentSessionEngine
  >[0]["commandPort"]["execute"]
) {
  return createAgentSessionEngine({
    clock: { nowUnixMs: () => Date.now() },
    commandPort: { execute },
    identity: {
      origin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
      workspaceId: "workspace-1"
    },
    scheduler: {
      schedule(delayMs, task) {
        const timer = setTimeout(task, delayMs);
        return { cancel: () => clearTimeout(timer) };
      }
    }
  });
}
