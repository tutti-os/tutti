import assert from "node:assert/strict";
import test from "node:test";
import type { PromptQueueSendCommand } from "./promptQueue.types.ts";
import {
  executeAgentActivityPromptCommand,
  type AgentActivityPromptCommandPort
} from "./promptCommandExecution.ts";

test("applies required settings before preserving every send semantic", async () => {
  const operations: string[] = [];
  const port: AgentActivityPromptCommandPort<{ accepted: true }> = {
    async updateSessionSettings(input) {
      operations.push(`settings:${input.settings.browserUse}`);
    },
    async sendInput(input) {
      operations.push(`send:${input.clientSubmitId}`);
      assert.deepEqual(input, {
        agentSessionId: "session-1",
        capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
        clientSubmitId: "submit-1",
        content: [{ text: "hello", type: "text" }],
        displayPrompt: "Hello",
        guidance: true,
        submitDiagnostics: {
          blockCount: 1,
          source: "test",
          submittedAtUnixMs: 10
        },
        workspaceId: "workspace-1"
      });
      return { accepted: true };
    }
  };

  const result = await executeAgentActivityPromptCommand(port, createCommand());

  assert.deepEqual(operations, ["settings:true", "send:submit-1"]);
  assert.deepEqual(result, { accepted: true });
});

test("does not send when the required settings patch fails", async () => {
  let sendCalls = 0;
  const expected = new Error("settings rejected");
  const port: AgentActivityPromptCommandPort = {
    async updateSessionSettings() {
      throw expected;
    },
    async sendInput() {
      sendCalls += 1;
    }
  };

  await assert.rejects(
    executeAgentActivityPromptCommand(port, createCommand()),
    expected
  );
  assert.equal(sendCalls, 0);
});

test("sends immediately when the command has no settings precondition", async () => {
  let settingsCalls = 0;
  let sendCalls = 0;
  const port: AgentActivityPromptCommandPort = {
    async updateSessionSettings() {
      settingsCalls += 1;
    },
    async sendInput() {
      sendCalls += 1;
    }
  };

  await executeAgentActivityPromptCommand(port, {
    ...createCommand(),
    requiredSettingsPatch: undefined
  });

  assert.equal(settingsCalls, 0);
  assert.equal(sendCalls, 1);
});

function createCommand(): PromptQueueSendCommand {
  return {
    agentSessionId: "session-1",
    capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
    clientSubmitId: "submit-1",
    commandId: "command-1",
    content: [{ text: "hello", type: "text" }],
    displayPrompt: "Hello",
    guidance: true,
    promptId: "prompt-1",
    requiredSettingsPatch: { browserUse: true },
    submitDiagnostics: {
      blockCount: 1,
      source: "test",
      submittedAtUnixMs: 10
    },
    type: "queue/sendPrompt",
    workspaceId: "workspace-1"
  };
}
