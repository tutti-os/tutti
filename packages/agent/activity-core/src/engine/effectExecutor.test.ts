import assert from "node:assert/strict";
import test from "node:test";
import { createEngineEffectExecutor } from "./effectExecutor.ts";
import type {
  AgentSessionEffectPort,
  EngineCommandPort,
  EngineCommandResultIntent,
  EngineExternalCommand,
  EngineTypedCommandPort
} from "./types.ts";

test("projects shared commands onto typed lifecycle effects without host switches", async () => {
  const calls: Array<{ input: unknown; kind: string; signal?: AbortSignal }> =
    [];
  const effects: AgentSessionEffectPort = {
    async activateSession(input, options) {
      calls.push({ input, kind: "activate", signal: options?.signal });
      return { accepted: true };
    },
    async cancelTurn(input, options) {
      calls.push({ input, kind: "cancel", signal: options?.signal });
    },
    async respondToInteraction(input, options) {
      calls.push({ input, kind: "respond", signal: options?.signal });
    },
    async sendInput(input, options) {
      calls.push({ input, kind: "send", signal: options?.signal });
    },
    async updateSessionSettings(input, options) {
      calls.push({ input, kind: "settings", signal: options?.signal });
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

  await executeAndWait(port, {
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-create",
    commandId: "activate-1",
    correlationId: "submit-create",
    cwd: "/repo",
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
    settings: { model: "model-1", planMode: true },
    submitDiagnostics: { blockCount: 1, source: "test" },
    title: "Session",
    type: "session/activate",
    visible: false,
    workspaceId: "workspace-1"
  });
  await executeAndWait(port, {
    agentSessionId: "session-1",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-send",
    commandId: "send-1",
    content: [{ text: "continue", type: "text" }],
    correlationId: "submit-send",
    displayPrompt: "Continue",
    promptId: "prompt-1",
    requiredSettingsPatch: { browserUse: true },
    type: "queue/sendPrompt",
    workspaceId: "workspace-1"
  });
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

  assert.equal(extensionCalls, 0);
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["activate", "settings", "send", "settings", "cancel", "respond"]
  );
  assert.deepEqual(calls[0]?.input, {
    agentSessionId: "session-1",
    agentTargetId: "target-1",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-create",
    cwd: "/repo",
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
    settings: { model: "model-1", planMode: true },
    submitDiagnostics: { blockCount: 1, source: "test" },
    title: "Session",
    visible: false,
    workspaceId: "workspace-1"
  });
  assert.deepEqual(calls[1]?.input, {
    agentSessionId: "session-1",
    commandId: "send-1",
    correlationId: "submit-send",
    settings: { browserUse: true },
    workspaceId: "workspace-1"
  });
  assert.deepEqual(calls[2]?.input, {
    agentSessionId: "session-1",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-send",
    content: [{ text: "continue", type: "text" }],
    displayPrompt: "Continue",
    workspaceId: "workspace-1"
  });
  assert.deepEqual(calls[3]?.input, {
    agentSessionId: "session-1",
    commandId: "settings-1",
    correlationId: "settings-1",
    settings: { speed: "fast" },
    workspaceId: "workspace-1"
  });
  assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
});

test("keeps the complete command union available to legacy hosts", async () => {
  const observed: string[] = [];
  const executed: EngineExternalCommand[] = [];
  const command: EngineExternalCommand = {
    agentSessionId: "session-legacy",
    commandId: "cancel-legacy",
    turnId: "turn-legacy",
    type: "turn/cancel",
    workspaceId: "workspace-legacy"
  };
  await executeAndWait(
    {
      async execute(candidate) {
        executed.push(candidate);
      },
      observe(candidate) {
        observed.push(candidate.commandId);
      }
    },
    command
  );

  assert.deepEqual(executed, [command]);
  assert.deepEqual(observed, ["cancel-legacy"]);
});

function executeAndWait(
  commandPort: EngineCommandPort | EngineTypedCommandPort,
  command: EngineExternalCommand
): Promise<EngineCommandResultIntent> {
  return new Promise((resolve) => {
    createEngineEffectExecutor({
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
