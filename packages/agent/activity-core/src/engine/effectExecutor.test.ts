import assert from "node:assert/strict";
import test from "node:test";
import { createEngineEffectExecutor } from "./effectExecutor.ts";
import { createTestEngineCommandPort } from "./testEngineCommandPort.ts";
import type { AgentActivitySession } from "../types.ts";
import type {
  AgentSessionEffectPort,
  EngineCommandResultIntent,
  EngineExternalCommand,
  EngineTypedCommandPort
} from "./types.ts";

test("projects shared commands onto typed lifecycle effects without host switches", async () => {
  const calls: Array<{
    commandId: string;
    input: unknown;
    kind: string;
    origin?: "engine";
    signal?: AbortSignal;
  }> = [];
  const session = {} as AgentActivitySession;
  const effects: AgentSessionEffectPort = {
    async activateSession(input, options) {
      calls.push({
        commandId: options.commandId,
        input,
        kind: "activate",
        origin: options.origin,
        signal: options.signal
      });
      return {
        activation: { mode: "new", status: "attached" },
        session
      };
    },
    async cancelTurn(input, options) {
      calls.push({
        commandId: options.commandId,
        input,
        kind: "cancel",
        origin: options.origin,
        signal: options.signal
      });
    },
    async controlGoal(input, options) {
      assert.ok(options);
      calls.push({
        commandId: options.commandId,
        input,
        kind: "goal",
        origin: options.origin,
        signal: options.signal
      });
      return { goal: null, session };
    },
    async deleteSessions(input, options) {
      calls.push({
        commandId: options?.commandId ?? "",
        input,
        kind: "delete",
        origin: options?.origin ?? "engine",
        signal: options?.signal
      });
      return {
        cleanupFailedSessionIds: [],
        removedMessages: 0,
        removedSessionIds: [],
        removedSessions: 0
      };
    },
    async respondToInteraction(input, options) {
      calls.push({
        commandId: options.commandId,
        input,
        kind: "respond",
        origin: options.origin,
        signal: options.signal
      });
    },
    async renameSession(input, options) {
      calls.push({
        commandId: options?.commandId ?? "",
        input,
        kind: "rename",
        origin: options?.origin,
        signal: options?.signal
      });
      return { session };
    },
    async sendInput(input, options) {
      calls.push({
        commandId: options.commandId,
        input,
        kind: "send",
        origin: options.origin,
        signal: options.signal
      });
    },
    async setSessionPinned(input, options) {
      calls.push({
        commandId: options?.commandId ?? "",
        input,
        kind: "pin",
        origin: options?.origin ?? "engine",
        signal: options?.signal
      });
      return { session };
    },
    async updateSessionSettings(input, options) {
      calls.push({
        commandId: options.commandId,
        input,
        kind: "settings",
        origin: options.origin,
        signal: options.signal
      });
    }
  };
  let extensionCalls = 0;
  const port: EngineTypedCommandPort = {
    effects,
    kind: "typed",
    async execute() {
      extensionCalls += 1;
    }
  };

  const activationResult = await executeAndWait(port, {
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-create",
    commandId: "activate-1",
    correlationId: "submit-create",
    cwd: "/repo",
    isolation: "worktree",
    modelExplicit: false,
    initialContent: [{ text: "build it", type: "text" }],
    initialDisplayPrompt: "Build it",
    initialGoalControl: { action: "set", objective: "ship it" },
    initialTuttiModeActivation: {
      effect: 80,
      source: "slash_command",
      speed: 60,
      status: "active"
    },
    mode: "new",
    railPlacement: {
      kind: "project",
      projectPath: "/repo",
      sectionKey: "project:/repo",
      version: 1
    },
    reasoningEffortExplicit: true,
    settings: { model: "model-1", planMode: true },
    submitDiagnostics: { blockCount: 1, source: "test" },
    title: "Session",
    type: "session/activate",
    visible: false,
    workspaceId: "workspace-1"
  });
  assert.equal(activationResult.resultContract, "activation-v1");
  const sendResult = await executeAndWait(port, {
    agentSessionId: "session-1",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-send",
    commandId: "send-1",
    content: [{ text: "continue", type: "text" }],
    correlationId: "submit-send",
    displayPrompt: "Continue",
    promptId: "prompt-1",
    type: "queue/sendPrompt",
    workspaceId: "workspace-1"
  });
  assert.equal(sendResult.resultContract, "opaque");
  await executeAndWait(port, {
    agentSessionId: "session-1",
    commandId: "settings-1",
    correlationId: "settings-1",
    settings: { speed: "fast" },
    type: "session/updateSettings",
    workspaceId: "workspace-1"
  });
  await executeAndWait(port, {
    agentSessionId: "session-1",
    commandId: "cancel-1",
    turnId: "turn-1",
    type: "turn/cancel",
    workspaceId: "workspace-1"
  });
  await executeAndWait(port, {
    agentSessionId: "session-1",
    commandId: "pin-1",
    correlationId: "pin-1",
    pinned: true,
    type: "session/setPinned",
    workspaceId: "workspace-1"
  });
  await executeAndWait(port, {
    agentSessionId: "session-1",
    commandId: "rename-1",
    correlationId: "rename-1",
    title: "Renamed session",
    type: "session/rename",
    workspaceId: "workspace-1"
  });
  await executeAndWait(port, {
    agentSessionIds: ["session-1", "session-2"],
    commandId: "delete-1",
    correlationId: "delete-1",
    type: "sessions/delete",
    workspaceId: "workspace-1"
  });
  await executeAndWait(port, {
    action: "accept",
    agentSessionId: "session-1",
    commandId: "respond-1",
    correlationId: "request-1",
    optionId: "yes",
    payload: { approved: true },
    requestId: "request-1",
    turnId: "turn-1",
    type: "interaction/respond",
    workspaceId: "workspace-1"
  });
  await executeAndWait(port, {
    action: "set",
    agentSessionId: "session-1",
    clientSubmitId: "goal-submit-1",
    commandId: "goal-1",
    correlationId: "goal-submit-1",
    objective: "ship it",
    type: "goal/control",
    workspaceId: "workspace-1"
  });

  assert.equal(extensionCalls, 0);
  assert.deepEqual(
    calls.map((call) => call.kind),
    [
      "activate",
      "send",
      "settings",
      "cancel",
      "pin",
      "rename",
      "delete",
      "respond",
      "goal"
    ]
  );
  assert.deepEqual(
    calls.map((call) => call.commandId),
    [
      "activate-1",
      "send-1",
      "settings-1",
      "cancel-1",
      "pin-1",
      "rename-1",
      "delete-1",
      "respond-1",
      "goal-1"
    ]
  );
  assert.deepEqual(calls[0]?.input, {
    activationId: "submit-create",
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-create",
    cwd: "/repo",
    isolation: "worktree",
    modelExplicit: false,
    initialContent: [{ text: "build it", type: "text" }],
    initialDisplayPrompt: "Build it",
    initialGoalControl: { action: "set", objective: "ship it" },
    initialTuttiModeActivation: {
      effect: 80,
      source: "slash_command",
      speed: 60,
      status: "active"
    },
    mode: "new",
    railPlacement: {
      kind: "project",
      projectPath: "/repo",
      sectionKey: "project:/repo",
      version: 1
    },
    reasoningEffortExplicit: true,
    settings: { model: "model-1", planMode: true },
    submitDiagnostics: { blockCount: 1, source: "test" },
    title: "Session",
    visible: false,
    workspaceId: "workspace-1"
  });
  assert.deepEqual(calls[1]?.input, {
    agentSessionId: "session-1",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-send",
    content: [{ text: "continue", type: "text" }],
    displayPrompt: "Continue",
    workspaceId: "workspace-1"
  });
  assert.deepEqual(calls[2]?.input, {
    agentSessionId: "session-1",
    commandId: "settings-1",
    correlationId: "settings-1",
    settings: { speed: "fast" },
    workspaceId: "workspace-1"
  });
  assert.deepEqual(calls[4]?.input, {
    agentSessionId: "session-1",
    pinned: true,
    workspaceId: "workspace-1"
  });
  assert.deepEqual(calls[5]?.input, {
    agentSessionId: "session-1",
    title: "Renamed session",
    workspaceId: "workspace-1"
  });
  assert.deepEqual(calls[6]?.input, {
    agentSessionIds: ["session-1", "session-2"],
    workspaceId: "workspace-1"
  });
  assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
  assert.deepEqual(
    calls.map((call) => call.origin),
    [
      "engine",
      "engine",
      "engine",
      "engine",
      "engine",
      "engine",
      "engine",
      "engine",
      "engine"
    ]
  );
});

test("projects plan decisions with exact Engine provenance", async () => {
  let receivedOptions: unknown;
  let receivedSignal: AbortSignal | undefined;
  const result = await executeAndWait(
    {
      ...createTestEngineCommandPort(async () => {
        throw new Error("unexpected generic execute");
      }),
      async executePlanDecision(_command, options) {
        assert.ok(options);
        receivedOptions = options;
        receivedSignal = options.signal;
        return {
          operation: {
            agentSessionId: "session-1",
            idempotencyKey: "decision-1",
            operationId: "operation-1",
            requestId: "request-1",
            status: "completed",
            turnId: "turn-1",
            workspaceId: "workspace-1"
          }
        };
      }
    },
    {
      action: "implement",
      agentSessionId: "session-1",
      commandId: "plan-1",
      correlationId: "plan-1",
      idempotencyKey: "decision-1",
      promptKind: "plan-implementation",
      requestId: "request-1",
      turnId: "turn-1",
      type: "plan/submitDecision",
      workspaceId: "workspace-1"
    }
  );

  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(receivedOptions, {
    commandId: "plan-1",
    origin: "engine",
    signal: receivedSignal
  });
  assert.ok(receivedSignal instanceof AbortSignal);
});

test("rejects prompt settings preconditions that bypass the Engine state machine", async () => {
  let executed = false;
  const result = await executeAndWait(
    createTestEngineCommandPort(async () => {
      executed = true;
    }),
    {
      agentSessionId: "session-1",
      clientSubmitId: "submit-1",
      commandId: "send-1",
      content: [{ text: "continue", type: "text" }],
      promptId: "prompt-1",
      requiredSettingsPatch: { browserUse: true },
      type: "queue/sendPrompt",
      workspaceId: "workspace-1"
    }
  );

  assert.equal(executed, false);
  assert.equal(result.outcome, "failed");
  assert.match(
    result.errorMessage ?? "",
    /settings preconditions must be resolved by the Engine/
  );
});

function executeAndWait(
  commandPort: EngineTypedCommandPort,
  command: EngineExternalCommand
): Promise<EngineCommandResultIntent> {
  return new Promise((resolve) => {
    createEngineEffectExecutor({
      clock: { nowUnixMs: () => 1234 },
      commandPort,
      onResult: resolve,
      scheduler: {
        schedule() {
          return { cancel() {} };
        }
      }
    }).execute(command);
  });
}
